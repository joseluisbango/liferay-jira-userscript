// ==UserScript==
// @name         Jira For CSEs
// @author       Ally, Rita, Dmcisneros
// @icon         https://www.liferay.com/o/classic-theme/images/favicon.ico
// @namespace    https://liferay.atlassian.net/
// @version      3.3
// @description  Jira statuses + Patcher and CP Link field + Internal Note highlight
// @match        https://liferay.atlassian.net/*
// @updateURL    https://github.com/AllyMech14/liferay-jira-userscript/raw/refs/heads/main/userscript.js
// @downloadURL  https://github.com/AllyMech14/liferay-jira-userscript/raw/refs/heads/main/userscript.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// ==/UserScript==

(async function () {
    'use strict';

    // Map of colors by normalized status (all lowercase, spaces removed)
    const statusColors = {
        'pending': '#8fb8f6',
        'awaitinghelp': '#d8a0f7',
        'withproductteam': '#d8a0f7',
        'withsre': '#d8a0f7',
        'inprogress': '#fd9891',
        'solutionproposed': '#FFEB3B',
        'solutionaccepted': '#FFEB3B',
        'closed': '#dddee1',
        'inactive': '#FFEB3B',
        'new': '#FFEB3B'
    };

    // Normalize any status text (remove spaces, punctuation, lowercase)
    function normalizeStatus(text) {
        return text
            .replace(/\s+/g, '')
            .replace(/[^a-zA-Z]/g, '')
            .toLowerCase();
    }

    // Apply colors dynamically
    function applyColors() {
        // Select both types of elements: dynamic class + data-testid containing "status"
        const elements = document.querySelectorAll('._bfhk1ymo,.jira-issue-status-lozenge, [data-testid*="issue.fields.status.common.ui.status-lozenge.3"]');

        elements.forEach(el => {
            const rawText = (el.innerText || el.textContent || '').trim();
            const key = normalizeStatus(rawText);
            const color = statusColors[key];
            if (color) {
                el.style.backgroundColor = color;
                el.style.color = '#000'; // dark text for contrast
                el.style.border = 'none';
                el.style.padding = '2px 6px';
                el.style.borderRadius = '4px';
                el.style.transition = 'background-color 0.3s ease';
            }
            el.querySelectorAll('span').forEach(span => {
                span.style.background = 'transparent';
            });
        });
    }

    function getTicketType() {
        const title = document.title;
        const match = title.match(/\[([A-Z]+)-\d+\]/);
        return match ? match[1] : null;
    }

    /*********** PATCHER LINK FIELD ***********/
    function getPatcherPortalAccountsHREF(path, params) {
        const portletId = '1_WAR_osbpatcherportlet';
        const ns = '_' + portletId + '_';
        const queryString = Object.keys(params)
            .map(key => (key.startsWith('p_p_') ? key : ns + key) + '=' + encodeURIComponent(params[key]))
            .join('&');
        return 'https://patcher.liferay.com/group/guest/patching/-/osb_patcher/accounts' + path + '?p_p_id=' + portletId + '&' + queryString;
    }

    function getAccountCode() {
        const accountDiv = document.querySelector('[data-testid="issue.views.field.single-line-text.read-view.customfield_12570"]');
        return accountDiv ? accountDiv.textContent.trim() : null;
    }

    function createPatcherField() {
        const ticketType = getTicketType();
        if (!['LRHC','LRFLS'].includes(ticketType)) return; // Only run for allowed types

        const originalField = document.querySelector('[data-component-selector="jira-issue-field-heading-field-wrapper"]');
        if (!originalField) return;
        if (document.querySelector('.patcher-link-field')) return;

        const accountCode = getAccountCode();
        const clone = originalField.cloneNode(true);
        // Remove the Assign to Me, which is duplicated
        const assignToMe = clone.querySelector('[data-testid="issue-view-layout-assignee-field.ui.assign-to-me"]');
        if (assignToMe) {
            assignToMe.remove();
        }
        clone.classList.add('patcher-link-field');

        const heading = clone.querySelector('h3');
        if (heading) heading.textContent = 'Patcher Link';

        const contentContainer = clone.querySelector('[data-testid="issue-field-inline-edit-read-view-container.ui.container"]');
        if (contentContainer) contentContainer.innerHTML = '';

        const link = document.createElement('a');
        if (accountCode) {
            link.href = getPatcherPortalAccountsHREF('', { accountEntryCode: accountCode });
            link.target = '_blank';
            link.textContent = accountCode;
        } else {
            link.textContent = 'Account Code Missing';
            link.style.color = '#999';
        }

        link.style.display = 'block';
        link.style.marginTop = '5px';
        link.style.textDecoration = 'underline';
        contentContainer && contentContainer.appendChild(link);

        originalField.parentNode.insertBefore(clone, originalField.nextSibling);
    }

    /*********** CUSTOMER PORTAL LINK FIELD ***********/

    // Cache for fetched data (more contained than unsafeWindow)
    const customerPortalCache = {
        issueKey: null,
        assetInfo: null,
        externalKey: null,
        promise: null // To prevent concurrent fetches
    };

    // 1. Utility function to get Issue Key
    function getIssueKey() {
        const url = window.location.href;
        const match = url.match(/[A-Z]+-\d+/g);
        // Return the last match (the most specific one, e.g., the current ticket)
        return match ? match[match.length - 1] : null;
    }

    // 2. Fetch customfield_12557 (Organization Asset)
    async function fetchAssetInfo(issueKey) {
        const apiUrl = `/rest/api/3/issue/${issueKey}?fields=customfield_12557`;
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error(`API failed (${res.status}) for ${apiUrl}`);
        const data = await res.json();
        const field = data.fields.customfield_12557?.[0];

        if (!field) {
            throw new Error('customfield_12557 missing or empty on ticket.');
        }

        // Return only necessary IDs
        return {
            workspaceId: field.workspaceId,
            objectId: field.objectId
        };
    }

    // 3. Fetch object from gateway API and extract External Key
    async function fetchExternalKey(workspaceId, objectId) {
        const url = `/gateway/api/jsm/assets/workspace/${workspaceId}/v1/object/${objectId}?includeExtendedInfo=false`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Gateway API failed (${res.status}) for ${url}`);
        const data = await res.json();

        const extAttr = data.attributes.find(attr => attr.objectTypeAttribute.name === 'External Key');
        if (!extAttr || !extAttr.objectAttributeValues.length) {
            throw new Error('External Key not found in asset attributes.');
        }
        return extAttr.objectAttributeValues[0].value;
    }

    // 4. Main function to fetch all data, with caching and concurrency control
    async function fetchCustomerPortalData(issueKey) {
        // Check cache first
        if (customerPortalCache.issueKey === issueKey && customerPortalCache.externalKey) {
            return customerPortalCache.externalKey;
        }

        // Clear cache if issue key changes
        if (customerPortalCache.issueKey !== issueKey) {
            customerPortalCache.issueKey = issueKey;
            customerPortalCache.assetInfo = null;
            customerPortalCache.externalKey = null;
            customerPortalCache.promise = null; // Clear previous promise
        }

        // Return existing fetch promise to avoid concurrent requests
        if (customerPortalCache.promise) {
            return customerPortalCache.promise;
        }

        // Start a new fetch sequence
        customerPortalCache.promise = (async () => {
            try {
                const assetInfo = await fetchAssetInfo(issueKey);
                customerPortalCache.assetInfo = assetInfo;

                const externalKey = await fetchExternalKey(assetInfo.workspaceId, assetInfo.objectId);
                customerPortalCache.externalKey = externalKey;

                return externalKey;
            } catch (error) {
                console.error('Failed to get Customer Portal Data:', error.message);
                // Clear cache/promise on failure to allow retry
                customerPortalCache.assetInfo = null;
                customerPortalCache.externalKey = null;
                customerPortalCache.promise = null;
                throw error; // Propagate error
            }
        })();

        return customerPortalCache.promise;
    }

    // 5. Build the customer portal URL
    function getCustomerPortalHref(externalKey) {
        return externalKey ? `https://support.liferay.com/project/#/${externalKey}` : null;
    }


    // 6. Main function to create and insert the field (handles UI updates only)
    async function createCustomerPortalField() {
        const ticketType = getTicketType();
        if (!['LRHC','LRFLS'].includes(ticketType)) return; // Only run for allowed types

        const originalField = document.querySelector('[data-component-selector="jira-issue-field-heading-field-wrapper"]');
        if (!originalField || document.querySelector('.customer-portal-link-field')) return;

        const issueKey = getIssueKey();
        if (!issueKey) return;

        // --- UI Setup ---
        const clone = originalField.cloneNode(true);
        // Remove duplicated "Assign to Me"
        clone.querySelector('[data-testid="issue-view-layout-assignee-field.ui.assign-to-me"]')?.remove();
        clone.classList.add('customer-portal-link-field');

        // Update field heading
        const heading = clone.querySelector('h3');
        if (heading) heading.textContent = 'Customer Portal';

        // Get content container
        const contentContainer = clone.querySelector('[data-testid="issue-field-inline-edit-read-view-container.ui.container"]');
        if (contentContainer) contentContainer.innerHTML = '';

        // Placeholder while fetching
        const statusText = document.createElement('span');
        statusText.textContent = 'Loading Portal Link...';
        statusText.style.color = '#FFA500'; // Orange for loading
        contentContainer?.appendChild(statusText);

        // Insert the cloned field *before* fetching to provide immediate feedback
        originalField.parentNode.insertBefore(clone, originalField.nextSibling);

        // --- Data Fetch and Link Creation ---
        try {
            const externalKey = await fetchCustomerPortalData(issueKey);
            const url = getCustomerPortalHref(externalKey);

            if (url && externalKey) {
                contentContainer.innerHTML = ''; // Clear loading text
                const link = document.createElement('a');
                link.href = url;
                link.target = '_blank';
                link.textContent = externalKey;
                link.style.cssText = 'display: block; margin-top: 5px; text-decoration: underline;';
                contentContainer.appendChild(link);
            } else {
                statusText.textContent = 'Link Not Found (Missing Key)';
                statusText.style.color = '#DC143C'; // Red for error
            }
        } catch (error) {
            contentContainer.innerHTML = ''; // Clear loading text
            const errorText = document.createElement('span');
            errorText.textContent = `Error: ${error.message}`;
            errorText.style.color = '#DC143C'; // Red for error
            contentContainer.appendChild(errorText);
            // Note: The original error is already logged by fetchCustomerPortalData
        }
    }

    /*********** INTERNAL NOTE HIGHLIGHT ***********/

    function highlightEditor() {
        const editorWrapper = document.querySelector('.css-sox1a6');
        const editor = document.querySelector('#ak-editor-textarea');
        const internalNoteButton = document.querySelector('#comment-editor-container-tabs-0');

        const isInternalSelected = internalNoteButton && internalNoteButton.getAttribute('aria-selected') === 'true';

        if (isInternalSelected) {
            if (editorWrapper) {
                editorWrapper.style.setProperty('background-color', '#FFFACD', 'important'); // pale yellow
                editorWrapper.style.setProperty('border', '2px solid #FFD700', 'important'); // golden border
                editorWrapper.style.setProperty('transition', 'background-color 0.3s, border 0.3s', 'important');
            }
            if (editor) {
                editor.style.setProperty('background-color', '#FFFACD', 'important'); // pale yellow
                editor.style.setProperty('transition', 'background-color 0.3s, border 0.3s', 'important');
            }
        } else {
            //If not internal note Remove highlight
            if (editorWrapper) {
                editorWrapper.style.removeProperty('background-color');
                editorWrapper.style.removeProperty('border');
            }
            if (editor) {
                editor.style.removeProperty('background-color');
            }
        }
    }
    /*********** INTERNAL NOTE - REMOVE SIGNATURE ***********/

    // Select the "Add internal note" button
    function removeSignatureFromInternalNote() {
        const addNoteButton = document.querySelector('button.css-yfvug5');

        if (addNoteButton) {
            addNoteButton.addEventListener('click', () => {
                // Create a MutationObserver to watch for the target paragraph appearing
                const observer = new MutationObserver((mutations, obs) => {
                    const targetParagraph = document.querySelector(
                        'p[data-prosemirror-node-name="paragraph"][data-prosemirror-node-block="true"]'
                    );

                    if (targetParagraph && targetParagraph.innerHTML.includes('Best regards')) {
                        // Remove the paragraph
                        targetParagraph.remove();
                    }
                });

                // Observe the whole document (you can narrow to a specific container if you know it)
                observer.observe(document.body, {
                    childList: true,
                    subtree: true,
                });
            });
        } else {
            console.warn('Add internal note button not found.');
        }
    }

    /*
    ===============================================================================
      OPTIONAL FEATURES
      1. Disable JIRA Shortcuts
      2. Open Tickets In a New Tab

      How to Use:
      1. Go to TamperMonkey Icon in the browser
      2. Enable/Disable Features
      3. Refresh Jira for changes to change affect

      Note: The features are disabled by default.

    ===============================================================================
    */
    /*********** TOGGLE MENU ***********/
    const DEFAULTS = {
        disableShortcuts: false,
        bgTabOpen: false
    };

    const S = {
        disableShortcuts: GM_getValue("disableShortcuts", DEFAULTS.disableShortcuts),
        bgTabOpen: GM_getValue("bgTabOpen", DEFAULTS.bgTabOpen),
    };

    function registerMenu() {
        GM_registerMenuCommand(
            `Disable Jira Shortcuts: ${S.disableShortcuts ? "ON" : "OFF"}`,
            () => toggleSetting("disableShortcuts")
        );
        GM_registerMenuCommand(
            `Open Tickets in New Tab: ${S.bgTabOpen ? "ON" : "OFF"}`,
            () => toggleSetting("bgTabOpen")
        );
    }

    function toggleSetting(key) {
        S[key] = !S[key];
        GM_setValue(key, S[key]);
        alert(`Toggled ${key} → ${S[key] ? "ON" : "OFF"}.\nReload Jira for full effect.`);
    }

    /*********** OPEN TICKETS IN A NEW TAB ***********/
    function backgroundTabLinks() {
        if (!S.bgTabOpen) return;
        document.addEventListener("click", backgroundTabHandler, true);
    }

    function backgroundTabHandler(e) {
        const link = e.target.closest("a");
        if (!link?.href) return;
        if (!/\/browse\/[A-Z0-9]+-\d+/i.test(link.href)) return;
        if (e.ctrlKey || e.metaKey || e.button !== 0) return;

        e.stopImmediatePropagation();
        e.preventDefault();
        window.open(link.href, "_blank");
    }

    /*********** DISABLE JIRA SHORTCUTS ***********/
    function disableShortcuts() {
        if (!S.disableShortcuts) return;

        window.addEventListener('keydown', blockShortcuts, true);
        window.addEventListener('keypress', stopEventPropagation, true);
        window.addEventListener('keyup', stopEventPropagation, true);
    }

    function blockShortcuts(e) {
        if (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
        e.stopImmediatePropagation();
    }

    function stopEventPropagation(e) {
        e.stopImmediatePropagation();
    }

    /*********** INITIAL RUN + OBSERVERS ***********/
    async function updateUI() {
        applyColors();
        createPatcherField();
        highlightEditor();
        await createCustomerPortalField();
        removeSignatureFromInternalNote();
    }

    await updateUI();
    registerMenu();
    disableShortcuts();
    backgroundTabLinks();

    const observer = new MutationObserver(updateUI);
    observer.observe(document.body, { childList: true, subtree: true });

})();