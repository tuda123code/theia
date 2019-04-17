/********************************************************************************
 * Copyright (C) 2018 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

// tslint:disable:no-any

import { inject, injectable, postConstruct } from 'inversify';
import { JSONExt } from '@phosphor/coreutils';
import { MessageService, Resource, ResourceProvider, Disposable } from '@theia/core';
import { PreferenceProvider, PreferenceSchemaProvider, PreferenceScope, PreferenceProviderDataChange } from '@theia/core/lib/browser';
import URI from '@theia/core/lib/common/uri';
import * as jsoncparser from 'jsonc-parser';

@injectable()
export abstract class AbstractResourcePreferenceProvider extends PreferenceProvider {

    protected preferences: { [key: string]: any } = {};
    protected resource: Promise<Resource>;

    @inject(ResourceProvider) protected readonly resourceProvider: ResourceProvider;
    @inject(MessageService) protected readonly messageService: MessageService;
    @inject(PreferenceSchemaProvider) protected readonly schemaProvider: PreferenceSchemaProvider;

    @postConstruct()
    protected async init(): Promise<void> {
        const uri = this.getUri();
        this.resource = this.resourceProvider(uri);

        // Try to read the initial content of the preferences.  The provider
        // becomes ready even if we fail reading the preferences, so we don't
        // hang the preference service.
        this.readPreferences()
            .then(() => this._ready.resolve())
            .catch(() => this._ready.resolve());

        const resource = await this.resource;
        this.toDispose.push(resource);
        if (resource.onDidChangeContents) {
            this.toDispose.push(resource.onDidChangeContents(() => this.readPreferences()));
        }
        this.toDispose.push(Disposable.create(() => this.reset()));
    }

    protected abstract getUri(): URI;
    protected abstract getScope(): PreferenceScope;

    getConfigUri(): URI;
    getConfigUri(resourceUri: string | undefined): URI | undefined;
    getConfigUri(resourceUri?: string): URI | undefined {
        if (!resourceUri) {
            return this.getUri();
        }
        return this.loaded && this.contains(resourceUri) ? this.getUri() : undefined;
    }

    protected contains(resourceUri: string | undefined): boolean {
        if (!resourceUri) {
            return true;
        }
        const domain = this.getDomain();
        if (!domain) {
            return true;
        }
        const resourcePath = new URI(resourceUri).path;
        return domain.some(uri => new URI(uri).path.relativity(resourcePath) >= 0);
    }

    getPreferences(resourceUri?: string): { [key: string]: any } {
        return this.loaded && this.contains(resourceUri) ? this.preferences : {};
    }

    async setPreference(key: string, value: any, resourceUri?: string): Promise<boolean> {
        if (!this.contains(resourceUri)) {
            return false;
        }
        const path = this.getPath(key);
        if (!path) {
            return false;
        }
        const resource = await this.resource;
        if (resource.saveContents) {
            const content = (await this.readContents()) || '';
            const formattingOptions = { tabSize: 3, insertSpaces: true, eol: '' };
            try {
                const edits = jsoncparser.modify(content, path, value, { formattingOptions });
                const result = jsoncparser.applyEdits(content, edits);

                await resource.saveContents(result);
            } catch (e) {
                const message = `Failed to update the value of ${key}.`;
                this.messageService.error(`${message} Please check if ${resource.uri.toString()} is corrupted.`);
                console.error(`${message} ${e.toString()}`);
                return false;
            }
            const oldValue = this.preferences[key];
            if (oldValue === value || oldValue !== undefined && value !== undefined // JSONExt.deepEqual() does not support handling `undefined`
                && JSONExt.deepEqual(value, oldValue)) {
                return true;
            }
            this.preferences[key] = value;
            this.emitPreferencesChangedEvent([{
                preferenceName: key, newValue: value, oldValue, scope: this.getScope(), domain: this.getDomain()
            }]);
        }
        return true;
    }

    protected getPath(preferenceName: string): string[] | undefined {
        return [preferenceName];
    }

    protected loaded = false;
    protected async readPreferences(): Promise<void> {
        const newContent = await this.readContents();
        this.loaded = newContent !== undefined;
        const newPrefs = newContent ? this.getParsedContent(newContent) : {};
        this.handlePreferenceChanges(newPrefs);
    }

    protected async readContents(): Promise<string | undefined> {
        try {
            const resource = await this.resource;
            return await resource.readContents();
        } catch {
            return undefined;
        }
    }

    protected getParsedContent(content: string): { [key: string]: any } {
        const jsonData = this.parse(content);

        const preferences: { [key: string]: any } = {};
        if (typeof jsonData !== 'object') {
            return preferences;
        }
        const uri = this.getUri();
        // tslint:disable-next-line:forin
        for (const preferenceName in jsonData) {
            const preferenceValue = jsonData[preferenceName];
            if (preferenceValue !== undefined && !this.schemaProvider.validate(preferenceName, preferenceValue)) {
                console.warn(`Preference ${preferenceName} in ${uri} is invalid.`);
                continue;
            }
            if (this.schemaProvider.testOverrideValue(preferenceName, preferenceValue)) {
                // tslint:disable-next-line:forin
                for (const overriddenPreferenceName in preferenceValue) {
                    const overriddeValue = preferenceValue[overriddenPreferenceName];
                    preferences[`${preferenceName}.${overriddenPreferenceName}`] = overriddeValue;
                }
            } else {
                preferences[preferenceName] = preferenceValue;
            }
        }
        return preferences;
    }

    protected parse(content: string): any {
        const strippedContent = jsoncparser.stripComments(content);
        return jsoncparser.parse(strippedContent);
    }

    protected handlePreferenceChanges(newPrefs: { [key: string]: any }): void {
        const oldPrefs = Object.assign({}, this.preferences);
        this.preferences = newPrefs;
        const prefNames = new Set([...Object.keys(oldPrefs), ...Object.keys(newPrefs)]);
        const prefChanges: PreferenceProviderDataChange[] = [];
        const uri = this.getUri();
        for (const prefName of prefNames.values()) {
            const oldValue = oldPrefs[prefName];
            const newValue = newPrefs[prefName];
            const schemaProperties = this.schemaProvider.getCombinedSchema().properties[prefName];
            if (schemaProperties) {
                const scope = schemaProperties.scope;
                // do not emit the change event if the change is made out of the defined preference scope
                if (!this.schemaProvider.isValidInScope(prefName, this.getScope())) {
                    console.warn(`Preference ${prefName} in ${uri} can only be defined in scopes: ${PreferenceScope.getScopeNames(scope).join(', ')}.`);
                    continue;
                }
            }
            if (newValue === undefined && oldValue !== newValue
                || oldValue === undefined && newValue !== oldValue // JSONExt.deepEqual() does not support handling `undefined`
                || !JSONExt.deepEqual(oldValue, newValue)) {
                prefChanges.push({
                    preferenceName: prefName, newValue, oldValue, scope: this.getScope(), domain: this.getDomain()
                });
            }
        }

        if (prefChanges.length > 0) { // do not emit the change event if the pref value is not changed
            this.emitPreferencesChangedEvent(prefChanges);
        }
    }

    protected reset(): void {
        const preferences = this.preferences;
        this.preferences = {};
        const changes: PreferenceProviderDataChange[] = [];
        for (const prefName of Object.keys(preferences)) {
            const value = preferences[prefName];
            if (value !== undefined) {
                changes.push({
                    preferenceName: prefName, newValue: undefined, oldValue: value, scope: this.getScope(), domain: this.getDomain()
                });
            }
        }
        if (changes.length > 0) {
            this.emitPreferencesChangedEvent(changes);
        }
    }

}
