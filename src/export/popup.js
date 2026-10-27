'use strict';
/*
 * Popup of an extension exported by Moss: lists the script's menu commands for the
 * current tab and runs the one you click.
 */
const LIST = document.getElementById('list');

/*
 * command_button(item) -> a button that runs one menu command, then closes the popup
 */
function command_button(item) {
    const button = document.createElement('button');
    button.textContent = item.caption;
    button.addEventListener('click', async function () {
        await chrome.runtime.sendMessage({ type: 'menu.run', conn: item.conn, id: item.id });
        window.close();
    });
    return button;
}

/*
 * main() — fill the popup
 */
async function main() {
    document.getElementById('title').textContent = chrome.runtime.getManifest().name;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab_id = tabs.length > 0 ? tabs[0].id : -1;
    const items = (await chrome.runtime.sendMessage({ type: 'menu.list', tab_id: tab_id })) || [];
    for (const item of items) {
        LIST.append(command_button(item));
    }
    if (items.length === 0) {
        const note = document.createElement('p');
        note.textContent = 'No commands on this page.';
        LIST.append(note);
    }
}

main();
