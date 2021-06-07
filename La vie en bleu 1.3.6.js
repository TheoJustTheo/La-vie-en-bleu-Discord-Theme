// ==UserScript==
// @name La vie en bleu 
// @version 1.3.6
// @author JustTheo
// @namespace http://tampermonkey.net/
// @run-at document-start
// @include https://discord.com/*
// @description Everything you need on discord
// ==/UserScript==
async function deleteMessages(authToken, authorId, guildId, channelId, minId, maxId, content, hasLink, hasFile, includeNsfw, includePinned, searchDelay, deleteDelay, extLogger, stopHndl, onProgress) {
    const start = new Date();
    let delCount = 0;
    let failCount = 0;
    let avgPing;
    let lastPing;
    let grandTotal;
    let throttledCount = 0;
    let throttledTotalTime = 0;
    let offset = 0;
    let iterations = -1;

    const wait = async ms => new Promise(done => setTimeout(done, ms));
    const msToHMS = s => `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`;
    const escapeHTML = html => html.replace(/[&<"']/g, m => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;', '\'': '&#039;' })[m]);
    const redact = str => `<span class="priv">${escapeHTML(str)}</span><span class="mask">REDACTED</span>`;
    const queryString = params => params.filter(p => p[1] !== undefined).map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
    const ask = async msg => new Promise(resolve => setTimeout(() => resolve(window.confirm(msg)), 10));
    const printDelayStats = () => log.verb(`Delete delay: ${deleteDelay}ms, Search delay: ${searchDelay}ms`, `Last Ping: ${lastPing}ms, Average Ping: ${avgPing | 0}ms`);
    const toSnowflake = (date) => /:/.test(date) ? ((new Date(date).getTime() - 1420070400000) * Math.pow(2, 22)) : date;

    const log = {
        debug() { extLogger ? extLogger('debug', arguments) : console.debug.apply(console, arguments); },
        info() { extLogger ? extLogger('info', arguments) : console.info.apply(console, arguments); },
        verb() { extLogger ? extLogger('verb', arguments) : console.log.apply(console, arguments); },
        warn() { extLogger ? extLogger('warn', arguments) : console.warn.apply(console, arguments); },
        error() { extLogger ? extLogger('error', arguments) : console.error.apply(console, arguments); },
        success() { extLogger ? extLogger('success', arguments) : console.info.apply(console, arguments); },
    };

    async function recurse() {
        let API_SEARCH_URL;
        if (guildId === '@me') {
            API_SEARCH_URL = `https://discord.com/api/v6/channels/${channelId}/messages/`; // DMs
        }
        else {
            API_SEARCH_URL = `https://discord.com/api/v6/guilds/${guildId}/messages/`; // Server
        }

        const headers = {
            'Authorization': authToken
        };

        let resp;
        try {
            const s = Date.now();
            resp = await fetch(API_SEARCH_URL + 'search?' + queryString([
                ['author_id', authorId || undefined],
                ['channel_id', (guildId !== '@me' ? channelId : undefined) || undefined],
                ['min_id', minId ? toSnowflake(minId) : undefined],
                ['max_id', maxId ? toSnowflake(maxId) : undefined],
                ['sort_by', 'timestamp'],
                ['sort_order', 'desc'],
                ['offset', offset],
                ['has', hasLink ? 'link' : undefined],
                ['has', hasFile ? 'file' : undefined],
                ['content', content || undefined],
                ['include_nsfw', includeNsfw ? true : undefined],
            ]), { headers });
            lastPing = (Date.now() - s);
            avgPing = avgPing > 0 ? (avgPing * 0.9) + (lastPing * 0.1) : lastPing;
        } catch (err) {
            return log.error('Search request threw an error:', err);
        }

        // not indexed yet
        if (resp.status === 202) {
            const w = (await resp.json()).retry_after;
            throttledCount++;
            throttledTotalTime += w;
            log.warn(`This channel wasn't indexed, waiting ${w}ms for discord to index it...`);
            await wait(w);
            return await recurse();
        }

        if (!resp.ok) {
            // searching messages too fast
            if (resp.status === 429) {
                const w = (await resp.json()).retry_after;
                throttledCount++;
                throttledTotalTime += w;
                searchDelay += w; // increase delay
                log.warn(`Being rate limited by the API for ${w}ms! Increasing search delay...`);
                printDelayStats();
                log.verb(`Cooling down for ${w * 2}ms before retrying...`);

                await wait(w * 2);
                return await recurse();
            } else {
                return log.error(`Error searching messages, API responded with status ${resp.status}!\n`, await resp.json());
            }
        }

        const data = await resp.json();
        const total = data.total_results;
        if (!grandTotal) grandTotal = total;
        const discoveredMessages = data.messages.map(convo => convo.find(message => message.hit === true));
        const messagesToDelete = discoveredMessages.filter(msg => {
            return msg.type === 0 || msg.type === 6 || (msg.pinned && includePinned);
        });
        const skippedMessages = discoveredMessages.filter(msg => !messagesToDelete.find(m => m.id === msg.id));

        const end = () => {
            log.success(`Ended at ${new Date().toLocaleString()}! Total time: ${msToHMS(Date.now() - start.getTime())}`);
            printDelayStats();
            log.verb(`Rate Limited: ${throttledCount} times. Total time throttled: ${msToHMS(throttledTotalTime)}.`);
            log.debug(`Deleted ${delCount} messages, ${failCount} failed.\n`);
        }

        const etr = msToHMS((searchDelay * Math.round(total / 25)) + ((deleteDelay + avgPing) * total));
        log.info(`Total messages found: ${data.total_results}`, `(Messages in current page: ${data.messages.length}, To be deleted: ${messagesToDelete.length}, System: ${skippedMessages.length})`, `offset: ${offset}`);
        printDelayStats();
        log.verb(`Estimated time remaining: ${etr}`)


        if (messagesToDelete.length > 0) {

            if (++iterations < 1) {
                log.verb(`Waiting for your confirmation...`);
                if (!await ask(`Do you want to delete ~${total} messages?\nEstimated time: ${etr}\n\n---- Preview ----\n` +
                    messagesToDelete.map(m => `${m.author.username}#${m.author.discriminator}: ${m.attachments.length ? '[ATTACHMENTS]' : m.content}`).join('\n')))
                    return end(log.error('Aborted by you!'));
                log.verb(`OK`);
            }

            for (let i = 0; i < messagesToDelete.length; i++) {
                const message = messagesToDelete[i];
                if (stopHndl && stopHndl() === false) return end(log.error('Stopped by you!'));

                log.debug(`${((delCount + 1) / grandTotal * 100).toFixed(2)}% (${delCount + 1}/${grandTotal})`,
                    `Deleting ID:${redact(message.id)} <b>${redact(message.author.username + '#' + message.author.discriminator)} <small>(${redact(new Date(message.timestamp).toLocaleString())})</small>:</b> <i>${redact(message.content).replace(/\n/g, '↵')}</i>`,
                    message.attachments.length ? redact(JSON.stringify(message.attachments)) : '');
                if (onProgress) onProgress(delCount + 1, grandTotal);

                let resp;
                try {
                    const s = Date.now();
                    const API_DELETE_URL = `https://discord.com/api/v6/channels/${message.channel_id}/messages/${message.id}`;
                    resp = await fetch(API_DELETE_URL, {
                        headers,
                        method: 'DELETE'
                    });
                    lastPing = (Date.now() - s);
                    avgPing = (avgPing * 0.9) + (lastPing * 0.1);
                    delCount++;
                } catch (err) {
                    log.error('Delete request throwed an error:', err);
                    log.verb('Related object:', redact(JSON.stringify(message)));
                    failCount++;
                }

                if (!resp.ok) {
                    // deleting messages too fast
                    if (resp.status === 429) {
                        const w = (await resp.json()).retry_after;
                        throttledCount++;
                        throttledTotalTime += w;
                        deleteDelay = w; // increase delay
                        log.warn(`Being rate limited by the API for ${w}ms! Adjusted delete delay to ${deleteDelay}ms.`);
                        printDelayStats();
                        log.verb(`Cooling down for ${w * 2}ms before retrying...`);
                        await wait(w * 2);
                        i--; // retry
                    } else {
                        log.error(`Error deleting message, API responded with status ${resp.status}!`, await resp.json());
                        log.verb('Related object:', redact(JSON.stringify(message)));
                        failCount++;
                    }
                }

                await wait(deleteDelay);
            }

            if (skippedMessages.length > 0) {
                grandTotal -= skippedMessages.length;
                offset += skippedMessages.length;
                log.verb(`Found ${skippedMessages.length} system messages! Decreasing grandTotal to ${grandTotal} and increasing offset to ${offset}.`);
            }

            log.verb(`Searching next messages in ${searchDelay}ms...`, (offset ? `(offset: ${offset})` : ''));
            await wait(searchDelay);

            if (stopHndl && stopHndl() === false) return end(log.error('Stopped by you!'));

            return await recurse();
        } else {
            if (total - offset > 0) log.warn('Ended because API returned an empty page.');
            return end();
        }
    }

    log.success(`\nStarted at ${start.toLocaleString()}`);
    log.debug(`authorId="${redact(authorId)}" guildId="${redact(guildId)}" channelId="${redact(channelId)}" minId="${redact(minId)}" maxId="${redact(maxId)}" hasLink=${!!hasLink} hasFile=${!!hasFile}`);
    if (onProgress) onProgress(null, 1);
    return await recurse();
}

//---- User interface ----//

let popover;
let btn;
let stop;

function initUI() {

    const insertCss = (css) => {
        const style = document.createElement('style');
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
        return style;
    }

    const createElm = (html) => {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.removeChild(temp.firstElementChild);
    }

    insertCss(`
        #undicord-btn{position: relative; height: 24px;width: auto;-webkit-box-flex: 0;-ms-flex: 0 0 auto;flex: 0 0 auto;margin: 0 8px;cursor:pointer; color: var(--interactive-normal);}
        #undiscord{position:fixed;top:100px;right:10px;bottom:10px;width:780px;z-index:99;color:var(--text-normal);background-color:var(--background-secondary);box-shadow:var(--elevation-stroke),var(--elevation-high);border-radius:4px;display:flex;flex-direction:column}
        #undiscord a{color:#00b0f4}
        #undiscord.redact .priv{display:none!important}
        #undiscord:not(.redact) .mask{display:none!important}
        #undiscord.redact [priv]{-webkit-text-security:disc!important}
        #undiscord .toolbar span{margin-right:8px}
        #undiscord button,#undiscord .btn{color:#fff;background:#7289da;border:0;border-radius:4px;font-size:14px}
        #undiscord button:disabled{display:none}
        #undiscord input[type="text"],#undiscord input[type="search"],#undiscord input[type="password"],#undiscord input[type="datetime-local"],#undiscord input[type="number"]{background-color:#202225;color:#b9bbbe;border-radius:4px;border:0;padding:0 .5em;height:24px;width:144px;margin:2px}
        #undiscord input#file{display:none}
        #undiscord hr{border-color:rgba(255,255,255,0.1)}
        #undiscord .header{padding:12px 16px;background-color:var(--background-tertiary);color:var(--text-muted)}
        #undiscord .form{padding:8px;background:var(--background-secondary);box-shadow:0 1px 0 rgba(0,0,0,.2),0 1.5px 0 rgba(0,0,0,.05),0 2px 0 rgba(0,0,0,.05)}
        #undiscord .logarea{overflow:auto;font-size:.75rem;font-family:Consolas,Liberation Mono,Menlo,Courier,monospace;flex-grow:1;padding:10px}
    `);

    popover = createElm(`
    <div id="undiscord" style="display:none;">
        <div class="header">
            Undiscord - Bulk delete messages
        </div>
        <div class="form">
            <div style="display:flex;flex-wrap:wrap;">
                <span>Authorization <a
                        href="https://github.com/victornpb/deleteDiscordMessages/blob/master/help/authToken.md" title="Help"
                        target="_blank">?</a> <button id="getToken">get</button><br>
                    <input type="password" id="authToken" placeholder="Auth Token" autofocus>*<br>
                    <span>Author <a href="https://github.com/victornpb/deleteDiscordMessages/blob/master/help/authorId.md"
                            title="Help" target="_blank">?</a> <button id="getAuthor">get</button></span>
                    <br><input id="authorId" type="text" placeholder="Author ID" priv></span>
                <span>Guild/Channel <a
                        href="https://github.com/victornpb/deleteDiscordMessages/blob/master/help/channelId.md" title="Help"
                        target="_blank">?</a>
                    <button id="getGuildAndChannel">get</button><br>
                    <input id="guildId" type="text" placeholder="Guild ID" priv><br>
                    <input id="channelId" type="text" placeholder="Channel ID" priv><br>
                    <label><input id="includeNsfw" type="checkbox">NSFW Channel</label><br><br>
                    <label for="file" title="Import list of channels from messages/index.json file"> Import: <span
                            class="btn">...</span> <input id="file" type="file" accept="application/json,.json"></label>
                </span><br>
                <span>Range <a href="https://github.com/victornpb/deleteDiscordMessages/blob/master/help/messageId.md"
                        title="Help" target="_blank">?</a><br>
                    <input id="minDate" type="datetime-local" title="After" style="width:auto;"><br>
                    <input id="maxDate" type="datetime-local" title="Before" style="width:auto;"><br>
                    <input id="minId" type="text" placeholder="After message with Id" priv><br>
                    <input id="maxId" type="text" placeholder="Before message with Id" priv><br>
                </span>
                <span>Search messages <a
                        href="https://github.com/victornpb/deleteDiscordMessages/blob/master/help/filters.md" title="Help"
                        target="_blank">?</a><br>
                    <input id="content" type="text" placeholder="Containing text" priv><br>
                    <label><input id="hasLink" type="checkbox">has: link</label><br>
                    <label><input id="hasFile" type="checkbox">has: file</label><br>
                    <label><input id="includePinned" type="checkbox">Include pinned</label>
                </span><br>
                <span>Search Delay <a
                href="https://github.com/victornpb/deleteDiscordMessages/blob/master/help/delay.md" title="Help"
                target="_blank">?</a><br>
                    <input id="searchDelay" type="number" value="100" step="100"><br>
                </span>
                <span>Delete Delay <a
                href="https://github.com/victornpb/deleteDiscordMessages/blob/master/help/delay.md" title="Help"
                target="_blank">?</a><br>
                    <input id="deleteDelay" type="number" value="1000" step="100">
                </span>
            </div>
            <hr>
            <button id="start" style="background:#43b581;width:80px;">Start</button>
            <button id="stop" style="background:#f04747;width:80px;" disabled>Stop</button>
            <button id="clear" style="width:80px;">Clear log</button>
            <label><input id="autoScroll" type="checkbox" checked>Auto scroll</label>
            <label title="Hide sensitive information for taking screenshots"><input id="redact" type="checkbox">Screenshot
                mode</label>
            <progress id="progress" style="display:none;"></progress> <span class="percent"></span>
        </div>
        <pre class="logarea">
            <center>Star this project on <a href="https://github.com/victornpb/deleteDiscordMessages" target="_blank">github.com/victornpb/deleteDiscordMessages</a>!\n\n
                <a href="https://github.com/victornpb/deleteDiscordMessages/issues" target="_blank">Issues or help</a>
            </center>
        </pre>
    </div>
    `);

    document.body.appendChild(popover);

    btn = createElm(`<div id="undicord-btn" tabindex="0" role="button" aria-label="Delete Messages" title="Delete Messages">
    <svg aria-hidden="false" width="24" height="24" viewBox="0 0 24 24">
        <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"></path>
        <path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"></path>
    </svg>
    <br><progress style="display:none; width:24px;"></progress>
</div>`);

    btn.onclick = function togglePopover() {
        if (popover.style.display !== 'none') {
            popover.style.display = 'none';
            btn.style.color = 'var(--interactive-normal)';
        }
        else {
            popover.style.display = '';
            btn.style.color = '#f04747';
        }
    };

    function mountBtn() {
        const toolbar = document.querySelector('[class^=toolbar]');
        if (toolbar) toolbar.appendChild(btn);
    }

    const observer = new MutationObserver(function (_mutationsList, _observer) {
        if (!document.body.contains(btn)) mountBtn(); // re-mount the button to the toolbar
    });
    observer.observe(document.body, { attributes: false, childList: true, subtree: true });

    mountBtn();

    const $ = s => popover.querySelector(s);
    const logArea = $('pre');
    const startBtn = $('button#start');
    const stopBtn = $('button#stop');
    const autoScroll = $('#autoScroll');

    startBtn.onclick = async e => {
        const authToken = $('input#authToken').value.trim();
        const authorId = $('input#authorId').value.trim();
        const guildId = $('input#guildId').value.trim();
        const channelIds = $('input#channelId').value.trim().split(/\s*,\s*/);
        const minId = $('input#minId').value.trim();
        const maxId = $('input#maxId').value.trim();
        const minDate = $('input#minDate').value.trim();
        const maxDate = $('input#maxDate').value.trim();
        const content = $('input#content').value.trim();
        const hasLink = $('input#hasLink').checked;
        const hasFile = $('input#hasFile').checked;
        const includeNsfw = $('input#includeNsfw').checked;
        const includePinned = $('input#includePinned').checked;
        const searchDelay = parseInt($('input#searchDelay').value.trim());
        const deleteDelay = parseInt($('input#deleteDelay').value.trim());
        const progress = $('#progress');
        const progress2 = btn.querySelector('progress');
        const percent = $('.percent');

        const fileSelection = $("input#file");
        fileSelection.addEventListener("change", () => {
            const files = fileSelection.files;
            const channelIdField = $('input#channelId');
            if (files.length > 0) {
                const file = files[0];
                file.text().then(text => {
                    let json = JSON.parse(text);
                    let channels = Object.keys(json);
                    channelIdField.value = channels.join(",");
                });
            }
        }, false);

        const stopHndl = () => !(stop === true);

        const onProg = (value, max) => {
            if (value && max && value > max) max = value;
            progress.setAttribute('max', max);
            progress.value = value;
            progress.style.display = max ? '' : 'none';
            progress2.setAttribute('max', max);
            progress2.value = value;
            progress2.style.display = max ? '' : 'none';
            percent.innerHTML = value && max ? Math.round(value / max * 100) + '%' : '';
        };


        stop = stopBtn.disabled = !(startBtn.disabled = true);
        for (let i = 0; i < channelIds.length; i++) {
            await deleteMessages(authToken, authorId, guildId, channelIds[i], minId || minDate, maxId || maxDate, content, hasLink, hasFile, includeNsfw, includePinned, searchDelay, deleteDelay, logger, stopHndl, onProg);
            stop = stopBtn.disabled = !(startBtn.disabled = false);
        }
    };
    stopBtn.onclick = e => stop = stopBtn.disabled = !(startBtn.disabled = false);
    $('button#clear').onclick = e => { logArea.innerHTML = ''; };
    $('button#getToken').onclick = e => {
        window.dispatchEvent(new Event('beforeunload'));
        const ls = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;
        $('input#authToken').value = JSON.parse(localStorage.token);
    };
    $('button#getAuthor').onclick = e => {
        $('input#authorId').value = JSON.parse(localStorage.user_id_cache);
    };
    $('button#getGuildAndChannel').onclick = e => {
        const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
        $('input#guildId').value = m[1];
        $('input#channelId').value = m[2];
    };
    $('#redact').onchange = e => {
        popover.classList.toggle('redact') &&
            window.alert('This will attempt to hide personal information, but make sure to double check before sharing screenshots.');
    };

    const logger = (type = '', args) => {
        const style = { '': '', info: 'color:#00b0f4;', verb: 'color:#72767d;', warn: 'color:#faa61a;', error: 'color:#f04747;', success: 'color:#43b581;' }[type];
        logArea.insertAdjacentHTML('beforeend', `<div style="${style}">${Array.from(args).map(o => typeof o === 'object' ? JSON.stringify(o, o instanceof Error && Object.getOwnPropertyNames(o)) : o).join('\t')}</div>`);
        if (autoScroll.checked) logArea.querySelector('div:last-child').scrollIntoView(false);
    };

    // fixLocalStorage
    window.localStorage = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;

}

initUI();

(function() {
let css = `
/* If you don't like one of those variables until "Other settings" you can delete them or you can also
    try to change those if you have some css knowledge */

:root {
/* -- Others settings -- */

/* User button spacing */
--user-buttons-spacing: 8px;

/* Avatar roundess */
--avatar-radius: 5px;

/* Status roundness */
--status-radius: 3px;

/* Server roundess */
--server-radius: 8px;

/* Avatar width in modals */
--avatar-width: 130px;

/* Change bonfire in modals */
--bonfire: url('https://media.discordapp.net/attachments/819755030454337537/823570533622874142/755243963253915698.gif');

/* Colored emoji picker */
--colored-emoji: grayscale(0%); /* Change the value to "100%" if you want the basic one */

/* Mention color */
--mention-color: #f04747;
--unread-color: #297EC0;

/* Mention color in chat */
--mention-color-bar: #C66262;
--mention-color-background: #c662621f;
--mention-color-hover: #c6626226;

/* User settings color (Mute, Deafen and settings) */
--user-buttons-color: #297EC0;

/* Chat buttons color */
--chat-buttons: #297EC0;


/* Status color */
--online: #43B581;
--iddle: #F9F76D;
--dnd: #FD6F6F;
--offline: #747F8D;

/* Circles next to role names */
--role-circle: 5px;

/* Tooltips */
--tooltips: block; /* Set it to "none" if you don't want it */

/* Discord logo */
--discord-logo: none; /* Set it to "block" if you want it */

}

.theme-dark {
    --background-tertiary: #101320;
    --background-secondary: #1e2233;
    --background-secondary-alt: #191f2e;
    --background-primary: #23283d;
    --background-mobile-primary: #23283d;
    --background-mobile-secondary: #1e2233;
    --channeltextarea-background: #191f2e;
    --background-accent: #297EC0;
    --background-modifier-hover: #1c2030;
    --background-modifier-active: #1a1e2e;
    --background-modifier-selected: #191f2e;
    --deprecated-card-bg: #12141f63;
    --background-floating: #101320;
    --deprecated-quickswitcher-input-background:#101320;
    --elevation-low: none;
    --scrollbar-auto-thumb: #121722;
    --scrollbar-auto-track: #191f2e;
    --scrollbar-thin-thumb: #141925;
    --activity-card-background: #101320;
}

.theme-light { /* I don't support light theme it's just for the "Create a server" popup */
    --background-tertiary: #101320;
    --background-secondary: #1e2233;
    --background-secondary-alt: #191f2e;
    --background-primary: #23283d;
    --background-accent: #297EC0;
    --background-modifier-hover: #262b41;
    --background-modifier-active: #262b41;
    --header-primary: #fff;
    --header-secondary: #b1b5b9;
    --text-normal: #8e9297;
}


.


/* If you don't like one of those variables until "Other settings" you can delete them or you can also
    try to change those if you have some css knowledge */

:root {
/* -- Others settings -- */

/* User button spacing */
--user-buttons-spacing: 8px;

/* Avatar roundess */
--avatar-radius: 5px;

/* Status roundness */
--status-radius: 3px;

/* Server roundess */
--server-radius: 8px;

/* Avatar width in modals */
--avatar-width: 130px;

/* Change bonfire in modals */
--bonfire: url('https://media.discordapp.net/attachments/819755030454337537/823570533622874142/755243963253915698.gif');

/* Colored emoji picker */
--colored-emoji: grayscale(0%); /* Change the value to "100%" if you want the basic one */

/* Mention color */
--mention-color: #f04747;
--unread-color: #297EC0;

/* Mention color in chat */
--mention-color-bar: #C66262;
--mention-color-background: #c662621f;
--mention-color-hover: #c6626226;

/* User settings color (Mute, Deafen and settings) */
--user-buttons-color: #297EC0;

/* Chat buttons color */
--chat-buttons: #297EC0;


/* Status color */
--online: #43B581;
--iddle: #F9F76D;
--dnd: #FD6F6F;
--offline: #747F8D;

/* Circles next to role names */
--role-circle: 5px;

/* Tooltips */
--tooltips: block; /* Set it to "none" if you don't want it */

/* Discord logo */
--discord-logo: none; /* Set it to "block" if you want it */

}

.theme-dark {
    --background-tertiary: #101320;
    --background-secondary: #1e2233;
    --background-secondary-alt: #191f2e;
    --background-primary: #23283d;
    --background-mobile-primary: #23283d;
    --background-mobile-secondary: #1e2233;
    --channeltextarea-background: #191f2e;
    --background-accent: #297EC0;
    --background-modifier-hover: #1c2030;
    --background-modifier-active: #1a1e2e;
    --background-modifier-selected: #191f2e;
    --deprecated-card-bg: #12141f63;
    --background-floating: #101320;
    --deprecated-quickswitcher-input-background:#101320;
    --elevation-low: none;
    --scrollbar-auto-thumb: #121722;
    --scrollbar-auto-track: #191f2e;
    --scrollbar-thin-thumb: #141925;
    --activity-card-background: #101320;
}

.theme-light { /* I don't support light theme it's just for the "Create a server" popup */
    --background-tertiary: #101320;
    --background-secondary: #1e2233;
    --background-secondary-alt: #191f2e;
    --background-primary: #23283d;
    --background-accent: #297EC0;
    --background-modifier-hover: #262b41;
    --background-modifier-active: #262b41;
    --header-primary: #fff;
    --header-secondary: #b1b5b9;
    --text-normal: #8e9297;
}
/* USRBG import */
@import url('https://discord-custom-covers.github.io/usrbg/dist/usrbg.css');


/* --------------------------- 🚥 WINDOWS BUTTONS PART --------------------------- */

.winButton-iRh8-Z:not(:last-child) > svg { display: none;}
.winButton-iRh8-Z:hover { background-color: var(--background-teritary);}
.winButton-iRh8-Z:not(:last-child)::after {
   content: "";
   border-radius: 50px;
   pointer-events: fill;
}
.winButtonClose-1HsbF- { margin-right: 5px;}
.winButtonClose-1HsbF-:after { padding: 6px;}
.winButtonClose-1HsbF-::after { background-image: url('https://discord.com/assets/8becd37ab9d13cdfe37c08c496a9def3.svg'); background-size: 100%;}
.winButtonClose-1HsbF-:hover::after { background-image: url('https://discord.com/assets/8becd37ab9d13cdfe37c08c496a9def3.svg'); background-size: 100%;}

.winButtonMinMax-PBQ2gm:nth-child(3):after { background-color: #297EC0; padding: 5px;}
.winButtonMinMax-PBQ2gm:nth-child(3):hover::after { background-color: #297EC0;}

.winButtonMinMax-PBQ2gm:last-child { color: #297EC0;}
.winButtonMinMax-PBQ2gm:last-child:hover { color: #297EC0;}
.winButtonMinMax-PBQ2gm:last-child rect { height: 3px; rx: 2px;}

/* --------------------------- 📜 SERVER LIST PART --------------------------- */

/* Server list */
.guilds-1SWlCJ .scroller-2TZvBN { contain: none !important; padding-bottom: 170px;}

/* Discover */
.pageWrapper-1PgVDX .scroller-1d5FgU { padding-left: 0;}
.discoverHeader-1TWTqG ~ .categoryItem-3zFJns { margin-left: 0;}
.discoverHeader-1TWTqG ~ .categoryItem-3zFJns .itemInner-3gVXMG { padding: 8px;}
.css-ix84ef-menu { background: var(--background-secondary-alt);}
.theme-dark .pageWrapper-1PgVDX, .theme-dark .css-1adxh11-control, .theme-dark .css-12hk9yc-control, .theme-dark .css-1emou8a-control { background: var(--background-secondary); }
.theme-light .root-1gCeng, .theme-light .footer-2gL1pp { box-shadow: none;}

/* Create a server modal */
.theme-light .lookFilled-1Gx00P.colorGrey-2DXtkV { background-color: var(--background-accent);}
.theme-light .contents-18-Yxp { color: #FFF;}
.templatesList-2E6rTe, .optionsList-3UMAjx { padding: 0 !important; border-radius: 0;}
.container-UC8Ug1 { border-radius: 0; transition: 0.2s}
.templatesList-2E6rTe .optionHeader-1-5lcp { text-align: center; margin: 12px 0;}
.createGuild-23lWNm { padding: 10px !important;}

/* User buttons */
.panels-j1Uci_ > .container-3baos1 > .flex-1xMQg5 {
    position: fixed;
    bottom: 0px; left: 0px;
    width: 72px; z-index: 1;
    padding: 20px 0 10px 0;
    flex-direction: column;
    background: linear-gradient(transparent, var(--background-tertiary) 15%);
}
.panels-j1Uci_ > .container-3baos1 > .flex-1xMQg5 > .button-14-BFJ { color: var(--user-buttons-color); margin: var(--user-buttons-spacing) auto 0 auto;}

/* GameActivity support */
#GameActivityToggleBtn .st0 { fill: var(--user-buttons-color);}

/* Hiding old emplacement */
.panels-j1Uci_ > .container-3baos1 { height: 0;}

/* Notifications settings */
.inner-1ilYF7 > .modal-yWgWj- > .header-1TKi98, .modal-yWgWj- { background: var(--background-secondary); }
.inner-1ilYF7 > .modal-yWgWj- > .scrollerBase-289Jih { background: var(--background-secondary); }

/* Mention gradient */
.unreadMentionsBar-1VrBNe .text-2e2ZyG { display: none; }

/* Top */
.unreadMentionsIndicatorTop-gA6RCh { width: 100%; height: 50px; padding: 0; top: -7px;}
.unreadMentionsIndicatorTop-gA6RCh .unreadMentionsBar-1VrBNe { border-radius: 0; background: linear-gradient(var(--mention-color), #0000); transition: 0.3s;}
.unreadMentionsIndicatorTop-gA6RCh .unreadMentionsBar-1VrBNe:active { background: linear-gradient(var(--mention-color), #0000);}

/* Bottom */
.unreadMentionsIndicatorBottom-BXS58x { width: 100%; height: 15px; padding: 0;}
.unreadMentionsIndicatorBottom-BXS58x .unreadMentionsBar-1VrBNe { border-radius: 0; background: linear-gradient(#0000, var(--mention-color));}
.unreadMentionsIndicatorBottom-BXS58x .unreadMentionsBar-1VrBNe:active { background: linear-gradient(#0000, var(--mention-color));}

/* Mention pill */
.lowerBadge-29hYVK { top: 0; left: 0px; }
.lowerBadge-29hYVK .numberBadge-2s8kKX { animation: 2s server-mention infinite;}

/* Unread pill */
.listItem-2P_4kh[vz-unread] .wrapper-25eVIn::before, .listItem-2P_4kh.unread .wrapper-25eVIn::before,
.wrapper-21YSNc[vz-unread]:not([vz-expanded]) .wrapper-25eVIn::before, .wrapper-21YSNc.unread:not(.expanded) .wrapper-25eVIn::before {
    content: "";
    position: absolute; display: block;
    top: 0px; left: 0px;
    width: 12px; height: 12px;
    z-index: 1;
    background: var(--unread-color);
    border-radius: 50%;
    animation: 2s server-unread infinite;
}
.listItem-2P_4kh[vz-unread] .pill-31IEus, .listItem-2P_4kh.unread .pill-31IEus,
.wrapper-21YSNc[vz-unread] .pill-31IEus, .wrapper-21YSNc.unread .pill-31IEus,
.listItem-2P_4kh.unread.mentioned .wrapper-25eVIn::before,
.listItem-2P_4kh[vz-unread][vz-mentioned] .wrapper-25eVIn::before,
.wrapper-21YSNc.unread.mentioned .wrapper-25eVIn::before,
.wrapper-21YSNc[vz-unread][vz-mentioned] .wrapper-25eVIn::before { display: none;}

@keyframes server-unread {
    0% { box-shadow: 0 0 0 0 var(--unread-color); }
    70% { box-shadow: 0 0 0 8px rgba(0, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);}}

@keyframes server-mention {
    0% { box-shadow: 0 0 0 0 var(--mention-color); }
    70% { box-shadow: 0 0 0 8px rgba(0, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);}}

/* --------------------------- 🟢 STATUS PICKER --------------------------- */
.full-motion .animatorTop-2Y7x2r.didRender-33z1u8 { transform: unset !important; transition: opacity 0.15s linear 0s;}

#status-picker {
    position: fixed;
    bottom: 8px; left: 77px;
    width: 230px;
    background: var(--background-tertiary);
    border-radius: 5px;
}

/* Avatar in status picker */
.avatarWrapper-2yR4wp[aria-expanded="true"] {
    left: 80px !important; bottom: 114px !important;
    z-index: 10005 !important;
    pointer-events: none;
}
.avatarWrapper-2yR4wp[aria-expanded="true"] .avatar-SmRMf2.wrapper-3t9DeA { padding: 10px;}

/* Username in status picker */
.avatarWrapper-2yR4wp[aria-expanded="true"] + .nameTag-3uD-yy {
    position: absolute; display: flex !important;
    bottom: 110px; left: 78px; width: 145px;
    justify-content: center;
}
.panels-j1Uci_ > .container-3baos1 .title-eS5yk3 { font-size: 18px;}

/* User buttons in status picker */
.avatarWrapper-2yR4wp[aria-expanded="true"] ~ div { z-index: 10005;}

/* Status grid */
#status-picker .scroller-3BxosC { display: grid; grid-template-columns: auto auto auto auto; margin: 55px 4px 4px 4px;}


/* Status */
.item-1tOPte:not(#status-picker-custom-status) > .statusItem-33LqPf { grid-template-columns: 100% 1fr;}
#status-picker .item-1tOPte { border-radius: 5px; margin: 3px; transition: 0.2s;}
#status-picker .item-1tOPte.focused-3afm-j { transition: 0.2s;}
.mask-1qbNWk.icon-1IxfJ2 { height: 18px; width: 18px; margin: auto;}
.customEmoji-2_2FwB { width: 20px; height: 20px;}
.customText-tY5LJn { font-size: 15px; }
#status-picker-online.colorDefault-2K3EoJ, #status-picker-online.colorDefault-2K3EoJ.focused-3afm-j { color: #FFFFFF;}
#status-picker-online.focused-3afm-j { background-color: #FFFFFF;}
#status-picker-idle.colorDefault-2K3EoJ, #status-picker-idle.colorDefault-2K3EoJ.focused-3afm-j { color: #FFFFFF;}
#status-picker-idle.focused-3afm-j { background-color:#FFFFFF;}
#status-picker-dnd.colorDefault-2K3EoJ, #status-picker-dnd.colorDefault-2K3EoJ.focused-3afm-j { color:#FFFFFF;}
#status-picker-dnd.focused-3afm-j { background-color: #FFFFFF;}
#status-picker-invisible.colorDefault-2K3EoJ, #status-picker-invisible.colorDefault-2K3EoJ.focused-3afm-j { color: #FFFFFF;}
#status-picker-invisible.focused-3afm-j { background-color:#FFFFFF;}
#status-picker-custom-status.focused-3afm-j { background-color: #FFFFFF;}
.customEmojiPlaceholder-37iZ_j { background-image: url(https://media.discordapp.net/attachments/787050568107556864/823059464546287636/emoji.png");}

/* Custom status */
#status-picker-custom-status { grid-column: 1/5;}
#status-picker-custom-status .status-1fhblQ { display: block;}

/* Hiding text and separators */
.separator-2I32lJ, .status-1fhblQ, .description-2L932D { display: none;}

/* Game Activity Toggle */
#status-picker [aria-label="Hide Game Activity"]:after,
#status-picker [aria-label="Show Game Activity"]:after { content: "Not supported in this area";}

/* Support plugin CustomStatusPresets */
#status-picker .submenuContainer-2gbm7M .item-1tOPte { border-radius: 5px; margin: 0 3px;}
#status-picker .submenuContainer-2gbm7M { grid-column: 1/5; }

/* Custom status modal */
.select-2fjwPw, .popout-VcNcHB { border: none;}
.select-2fjwPw.open-kZ53_U, .popout-VcNcHB { background-color: var(--background-secondary-alt); transition: 0.15s;}
.theme-dark .footer-2gL1pp { background: var(--background-tertiary);}

/* --------------------------- ✏️ CHANNEL PART --------------------------- */

/* -- Guild header popout -- */
#guild-header-popout .labelContainer-1BLJti { flex-direction: row-reverse;}
#guild-header-popout .iconContainer-2-XQPY { margin: 0 8px 0 0;}

/* Boost */
#guild-header-popout-premium-subscribe:hover .icon-LYJorE, #guild-header-popout-premium-subscribe:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #FF73FA;}
#guild-header-popout-premium-subscribe:hover, #guild-header-popout-premium-subscribe:active:not(.hideInteraction-1iHO1O) { background-color: #ff73fa34; border-radius: 5px 5px 0 0;}

/* Invite */
#guild-header-popout-invite-people:hover .icon-LYJorE, #guild-header-popout-invite-people:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #677BC4;}
#guild-header-popout-invite-people:hover, #guild-header-popout-invite-people:active:not(.hideInteraction-1iHO1O) { background-color: #677bc442; color: #677BC4;}

/* Settings */
#guild-header-popout-settings .icon-LYJorE, #guild-header-popout-settings:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #546E7A;}
#guild-header-popout-settings:hover, #guild-header-popout-settings:active:not(.hideInteraction-1iHO1O){ background-color: #546e7a36;}

/* Insights */
#guild-header-popout-insights .icon-LYJorE, #guild-header-popout-insights:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #1ABC9C;}
#guild-header-popout-insights:hover, #guild-header-popout-insights:active:not(.hideInteraction-1iHO1O) { background-color: #1abc9c38;}

/* Create channel */
#guild-header-popout-create-channel .icon-LYJorE, #guild-header-popout-create-channel:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #E91E63;}
#guild-header-popout-create-channel:hover, #guild-header-popout-create-channel:active:not(.hideInteraction-1iHO1O) { background-color: #e91e6238;}

/* Create category */
#guild-header-popout-create-category .icon-LYJorE, #guild-header-popout-create-category:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #EAA14E;}
#guild-header-popout-create-category:hover, #guild-header-popout-create-category:active:not(.hideInteraction-1iHO1O) { background-color: #eaa14e34;}

/* Notifications */
#guild-header-popout-notifications .icon-LYJorE, #guild-header-popout-notifications:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #FCD462;}
#guild-header-popout-notifications:hover, #guild-header-popout-notifications:active:not(.hideInteraction-1iHO1O){ background-color: #e9bb4832;}

/* Privacy */
#guild-header-popout-privacy .icon-LYJorE, #guild-header-popout-privacy:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #4a84d4;}
#guild-header-popout-privacy:hover, #guild-header-popout-privacy:active:not(.hideInteraction-1iHO1O) { background-color: #4a83d434;}

/* Nickname */
#guild-header-popout-change-nicknam .icon-LYJorE, #guild-header-popout-change-nickname:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #43B581;}
#guild-header-popout-change-nickname:hover, #guild-header-popout-change-nickname:active:not(.hideInteraction-1iHO1O) { background-color: #43b5823a;}

/* Hide muted channels */
#guild-header-popout-hide-muted-channels:hover svg > path:first-child { color: #5C6FB1;}
#guild-header-popout-hide-muted-channels:hover, #guild-header-popout-hide-muted-channels:active:not(.hideInteraction-1iHO1O) { background-color: #5c6eb141;}
#guild-header-popout-hide-muted-channels:hover svg > path:last-child { color: #fff;}

/* Leave */
#guild-header-popout-leave:hover .icon-LYJorE, #guild-header-popout-leave:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #F04747;}
#guild-header-popout-leave:hover, #guild-header-popout-leave:active:not(.hideInteraction-1iHO1O) { background-color: #f047472f; color: #F04747;}

/* Categories arrows */
.mainContent-2h-GEV .arrow-gKvcEx { display: none;}

/* Channel call */
.voiceUserSummary-2X_2vp svg:not(.icon-1tDorc) { padding-right: 15px;}

/* -- Notification -- */
.container-1taM1r { background: var(--background-secondary) !important; z-index: 3;}
.unreadTop-3rAB3r { width: 100%; padding: 0; z-index: 2; top: -9px;}
.unreadBottom-1_LF_w { width: 100%; height: 15px; padding: 0;}

/* Mention gradient */
.unreadTop-3rAB3r > .unreadBar-3t3sYc.mention-1f5kbO { border-radius: 0; background: linear-gradient(var(--mention-color), #0000);}
.unreadBottom-1_LF_w > .unreadBar-3t3sYc.mention-1f5kbO { border-radius: 0; background: linear-gradient(#0000, var(--mention-color));}

/* Unread gradient */
.unreadTop-3rAB3r > .unreadBar-3t3sYc.unread-1xRYoj { border-radius: 0; background: linear-gradient(var(--unread-color), #0000);}
.unreadBottom-1_LF_w > .unreadBar-3t3sYc.unread-1xRYoj { border-radius: 0; background: linear-gradient(#0000, var(--unread-color));}
.unreadBar-3t3sYc > .text-2e2ZyG { display: none; }

/* Mention pill */
.mentionsBadge-3tC7Mi .numberBadge-2s8kKX { animation: 2s channel-mention infinite;}

/* Unread pill */
.unread-2lAfLh {
    top: 54%; left: 5px;
    width: 6px; height: 6px;
    background-color: var(--unread-color);
    border-radius: 10px;
    animation: 2s channel-unread infinite;
}

@keyframes channel-mention {
    0% { box-shadow: 0 0 0 0 var(--mention-color); }
    70% { box-shadow: 0 0 0 5px rgba(0, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);}}

@keyframes channel-unread {
    0% { box-shadow: 0 0 0 0 var(--unread-color); }
    70% { box-shadow: 0 0 0 4px rgba(0, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);}}

/* Game activity/call area */
.activityPanel-28dQGo, .container-1giJp5 { border-bottom: none; }

/* Hiding old user things emplacement */
.panels-j1Uci_ > .container-3baos1 .nameTag-3uD-yy, .panels-j1Uci_ > .container-3baos1 .subtext-3CDbHg { display: none;}

/* Adding role permissions into channel settings */
.theme-dark .autocompleteArrow-Zxoy9H, .theme-dark .header-2bNvm4 { background: var(--background-secondary-alt); }
.theme-dark .container-VSDcQc .sectionTag-pXyto9 { background: var(--background-secondary); }
.container-VSDcQc .headerText-3i6A8K { margin-left: 15px;}
.row-rrHHJU { padding: 0;}

/* Boost */
.theme-dark .perksModal-fSYqOq { background: var(--background-primary); }
.theme-dark .tierMarkerBackground-3q29am, .theme-dark .tierHeaderLocked-1s2JJz, .theme-dark .barBackground-2EEiLw, .theme-dark .icon-TYbVk4 { background: var(--background-secondary-alt); }
.option-96V44q.selected-rZcOL-, .tierBody-16Chc9, .perk-2WeBWW, .tierMarkerInProgress-24LMzJ { background: var(--background-secondary) !important; }

/* --------------------------- 💬 TCHAT PART --------------------------- */

/* Channel bar */
.container-1r6BKw.themed-ANHk51 { background: var(--background-secondary); }
.theme-dark .children-19S4PO:after { background: linear-gradient(90deg,rgba(54,57,63,0) 0,var(--background-secondary));}
.search-36MZv- { order: 1;}
.searchBar-3dMhjb { width: 27px; transition: 0.25s;}
.search-2oPWTC.focused-31_ccS { transition: 0.25s;}
.focused-31_ccS .searchBar-3dMhjb, .searchBar-3dMhjb:hover { width: 210px;}
[href="https://support.discord.com"] { display: none;}

/* -- Search bar and modal -- */
.theme-dark .elevationBorderHigh-2WYJ09 { box-shadow: none;}
.resultsGroup-r_nuzN .header-2N-gMV { text-align: center;}
.option-96V44q { margin: 0; border-radius: 0;}
.theme-dark .container-3ayLPN, .theme-dark .focused-2bY0OD { background-color: var(--background-secondary-alt);}
.theme-dark .searchAnswer-3Dz2-q, .theme-dark .searchFilter-2ESiM3 { background-color: var(--background-primary);}
.theme-dark .option-96V44q:after { background: linear-gradient(90deg,rgba(54,57,63,0),var(--background-secondary-alt) 80%);}
.theme-dark .option-96V44q.selected-rZcOL-:after { background: linear-gradient(90deg,rgba(54,57,63,0),var(--background-secondary) 80%);}

/* Calendar */
.theme-dark .calendarPicker-2yf6Ci .react-datepicker { background-color: var(--background-secondary-alt);}
.theme-dark .calendarPicker-2yf6Ci .react-datepicker__day.react-datepicker__day--disabled, .theme-dark .calendarPicker-2yf6Ci .react-datepicker__day.react-datepicker__day--disabled:hover,.theme-dark .calendarPicker-2yf6Ci .react-datepicker__header { background: var(--background-secondary-alt) !important;}
.searchLearnMore-3SQUAj { display: none; }

/* Avatar of the user */
.panels-j1Uci_ > .container-3baos1 > .avatarWrapper-2yR4wp {
    position: fixed;
    bottom: 26.5px; left: 327.5px;
    z-index: 2;
    margin: 0;
}
.panels-j1Uci_ > .container-3baos1 > .avatarWrapper-2yR4wp > .avatar-SmRMf2 { width: 40px !important; height: 40px !important;}
.panels-j1Uci_ > .container-3baos1 > .avatarWrapper-2yR4wp > .avatar-SmRMf2:hover { opacity: 1;}

/* Hiding avatar */
.content-98HsJk > :nth-child(2):not(.chat-3bRxxu) { z-index: 2;}

/* Chat bar */
.form-2fGMdU { padding-left: 66px;}
.channelTextArea-rNsIhG .scrollableContainer-2NUZem:after, .form-2fGMdU .wrapper-39oAo3:after {
    position: absolute;
    content: "";
    bottom: 2px; left: -50px;
    width: 40px; height: 40px;
    background: var(--bonfire) center no-repeat;
    background-size: 90%;
    background-color: var(--background-secondary);
    border-radius: calc(var(--avatar-radius) + 2px);
}

/* Typing indicator */
.typing-2GQL18 { left: 66px; right: 26px;}

/* Annoucement bar */
.theme-dark .lookFilled-1Gx00P.colorPrimary-3b3xI6, .theme-dark .lookFilled-1Gx00P.colorPrimary-3b3xI6:hover { background-color: var(--background-accent);}

/* Messages error bar */
.messagesErrorBar-nyJGU7 { border-radius: 15px; padding-bottom: 0; margin-bottom: 15px;}
.messagesErrorBar-nyJGU7:active { margin-bottom: 14px;}

/* New messages */
.newMessagesBar-265mhP { background-color: var(--background-accent); border-radius: 50px; margin-top: 5px; }

/* Mentions */
.mentioned-xhSam7:before { background: var(--mention-color-bar); padding: 1px;}
.mentioned-xhSam7 { background-color: var(--mention-color-background);}
.message-2qnXI6.mentioned-xhSam7.selected-2P5D_Z, .mouse-mode.full-motion .mentioned-xhSam7:hover { background-color: var(--mention-color-hover);}

/* Going back to new messages */
.jumpToPresentBar-G1R9s6, .jumpToPresentBar-G1R9s6:active { margin-bottom: 13px; border-radius: 20px; padding: 0;}

/* # @ / autocomplete menu */
.autocompleteRow-2OthDa { padding: 0;}
.autocompleteRow-2OthDa .base-1pYU8j { border-radius: 0;}
.autocompleteRow-2OthDa:first-of-type, .theme-dark .option-1B5ZV8 { background-color: var(--background-tertiary);}
.theme-dark .autocomplete-3l_oCd { background: var(--background-secondary-alt);}
.theme-dark .categoryHeader-O1zU94, .theme-dark .autocomplete-1vrmpx { background: var(--background-secondary); }
.theme-dark .selected-1Tbx07 { background: var(--background-primary);}

/* Upload modal */
.theme-dark .uploadModal-2ifh8j { background: var(--background-primary);}
.theme-dark .footer-3mqk7D { background: var(--background-tertiary);}

/* -- Emote picker -- */
.sprite-2iCowe { filter: var(--colored-emoji) !important;}

#emoji-picker-tab .contents-18-Yxp, #sticker-picker-tab .contents-18-Yxp { text-indent: 100%; overflow: hidden;}

.navList-2UtuhC > *:not(#gif-picker-tab) > .navButton-2gQCx-:after {
    position: absolute;
    content: "";
    width: 20px; height: 20px;
    background-size: 100%;
    background-repeat: no-repeat;
}
.navList-2UtuhC #sticker-picker-tab .navButton-2gQCx-:after { background-image:url("https://media.discordapp.net/attachments/819755030454337537/823283472763453440/image.png");}
.navList-2UtuhC #emoji-picker-tab .navButton-2gQCx-:after { background-image:url("https://media.discordapp.net/attachments/787050568107556864/823059464546287636/emoji.png");}
.navList-2UtuhC .navButton-2gQCx- { width: 40px; padding: 8px;}
.navList-2UtuhC .navButton-2gQCx-.navButtonActive-1MkytQ, .emojiItem-14v6tW.emojiItemSelected-1aLkfV { background-color: #297EC021;}
.contentWrapper-SvZHNd { grid-row-gap: 20px; padding-top: 8px;}
.header-19cWci > .arrow-gKvcEx { display: none;}

/* Chat buttons */
.attachButton-2WznTc .attachButtonPlus-jWVFah, .attachButton-2WznTc:hover .attachButtonPlus-jWVFah { fill: var(--chat-buttons);}
.theme-dark .buttonWrapper-1ZmCpA, .icon-3D60ES { color: var(--chat-buttons); }

/* --------------------------- 👥 MEMBERS PART --------------------------- */

/* -- Member popout -- */
.userPopout-3XzG_A { box-shadow: 0 0 10px 0 #101320d2;}
.userPopout-3XzG_A > :first-child { background: var(--background-tertiary);}
.theme-dark .body-3iLsc4, .theme-dark .footer-1fjuF6 { background: var(--background-secondary); }
.footer-1fjuF6 .inputDefault-_djjkz { border: none; background: var(--background-secondary-alt);}
.note-3HfJZ5 .textarea-2r0oV8:focus { background-color: var(--background-tertiary);}

}

/* Roles */
.role-2irmRk {
    position: relative;
    overflow: hidden;
    z-index: 1;
    border: solid;
    border-width: 0px 0px 0px 3px;
    border-radius: 1px 3px 3px 1px;
}

.roleCircle-3xAZ1j { width: var(--role-circle) !important; height: var(--role-circle) !important;}

.roleCircle-3xAZ1j::before {
    position: absolute;
    content: "";
    top: 0px; left: 0px;
    width: 100%; height: 100%;
    background: inherit;
    opacity: 0.3;
    z-index: -1;
}

/* Roles selector */
.container-3XJ8ns { border: none; padding: 0; background-color: #191f2e; }
.container-3XJ8ns .container-cMG81i { border-radius: 5px 5px 0 0;}
.container-3XJ8ns .list-1xE9GQ { margin: 0; padding: 0;}
.container-3XJ8ns .item-2J2GlB { border-radius: 0;}

/* -- USRBG Small Popout -- */
.header-2BwW8b { transform:translateZ(0);}

#app-mount .userPopout-3XzG_A .wrapper-3t9DeA[style*="width: 80px;"]::after {
	content: '';
	position: fixed;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
    z-index: -1;
    border-radius: 5px 5px 0 0;
    pointer-events: none;
    opacity: .8;
	background-size: cover;
	background-repeat: no-repeat;
	background-position: var(--user-popout-position) center;
	background-image: var(--user-background);
    -webkit-mask-image: linear-gradient(#000000, #0000004f);
    mask-image: linear-gradient(0.25turn, #0009, #0000);
}

.userPopout-3XzG_A  .header-2BwW8b,
.userPopout-3XzG_A  .scroller-2FKFPG,
.userPopout-3XzG_A  .footer-1fjuF6,
.body-3iLsc4 { z-index: 1;}

/* -- User modal -- */

/* User */
.modal-3c3bKg .root-SR8cQa { width: 700px;}
.topSectionNormal-2-vo2m > * { padding: 0 30px;}
.header-QKLPzZ {
    flex-direction: column;
    width: 200px;
    background: var(--background-secondary);
    margin: 10px 10px 0px 10px;
    padding-top: 15px;
    border-radius: 5px 5px 0 0;
}
.headerInfo-30uryT { padding: 15px 0 5px 0;}

/* Avatar */
.avatar-3EQepX { margin-right: 0; width: var(--avatar-width) !important; height: var(--avatar-width) !important;}
.header-QKLPzZ .mask-1l8v16 .pointerEvents-2zdfdO { display: none; }
.header-QKLPzZ .mask-1l8v16 foreignObject { mask: none; border-radius: var(--avatar-radius); }

/* Badges */
.profileBadges-2vWUYb { display: flex; justify-content: center; flex-wrap: wrap;}
.profileBadgeWrapper-1rGSsp { margin: 0 5px 0 5px; padding-bottom: 7px;}

/* Username + tag */
.headerInfo-30uryT .nameTag-2IFDfL { justify-content: center; margin: 0 0 10px 0;}
.discriminator-xUhQkU { font-size: 16px;}

/* 3 dots thing */
.additionalActionsIcon-1FoUlE { transform: rotate(90deg); margin: 10px;}

/* -- Activities -- */
.headerFill-adLl4x, .topSectionNormal-2-vo2m > div {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    width: 440px;
    background-color: transparent;
}
.root-SR8cQa > :first-child { background: var(--background-tertiary); display: flex;}
.activityProfile-2bJRaP { border-radius: 5px; margin: 13px;}

/* No activity */
.topSectionNormal-2-vo2m > div > div:first-of-type:not(.activity-1ythUs) .tabBar-2MuP6-::after  {
    content: "";
    position: absolute;
    top: 10px;
    width: 430px;
    height: 270px;
    background: url(https://cdn.discordapp.com/attachments/819755030454337537/823568767434489936/compressed_cat.gif) center no-repeat;
    background-size: 25%;
    border-radius: 5px;
}
.topSectionNormal-2-vo2m .actionButton-3W1xZa { background: #43b582b2 !important; backdrop-filter: blur(10px);}
.activity-1ythUs { margin-bottom: auto; }
.headerFill-adLl4x > .activity-1ythUs:not(.activityProfile-2bJRaP) { margin-bottom: 0 !important; padding-bottom: 5px;}
div:not(.headerFill-adLl4x) > .activity-1ythUs { text-align: center; margin-top: auto;}
.size12-3cLvbJ.activityHeader-1PExlk { display: none;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .size16-1P40sf { font-size: 19px;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .customStatus-154i-H { display: flex; flex-direction: column; align-items: center;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .customStatusEmoji-3BvdMX { width: 60px; height: 60px;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .customStatusSoloEmoji-192Z_4 { width: 80px; height: 80px;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .customStatusEmoji-3BvdMX:not(.customStatusSoloEmoji-192Z_4) { margin: 0 0 20px 0;}
.activityProfile-2bJRaP.activity-1ythUs { margin-bottom: auto; }

/* Infos / Server / Friends */
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) { border-top: none; padding-left: 0; padding-top: 10px;}
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) > .tabBar-2MuP6- { justify-content: center;}
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="USER_INFO-tab"],
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="MUTUAL_GUILDS-tab"],
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="MUTUAL_FRIENDS-tab"] {
    text-indent: 100%; overflow: hidden;
    margin: 0 30px; width: 30px;
}
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="USER_INFO-tab"]:after,
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="MUTUAL_GUILDS-tab"]:after,
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="MUTUAL_FRIENDS-tab"]:after {
    position: absolute;
    content: "";
    width: 30px; height: 30px;
    background-size: 100%;
    background-repeat: no-repeat;
}

[aria-controls="USER_INFO-tab"]:after { background-image:url("https://media.discordapp.net/attachments/787050568107556864/823057541881397278/user.png");}
[aria-controls="MUTUAL_GUILDS-tab"]:after { background-image: url("https://media.discordapp.net/attachments/787050568107556864/823057721577177098/guild.png");}
[aria-controls="MUTUAL_FRIENDS-tab"]:after { background-image:url("https://media.discordapp.net/attachments/787050568107556864/823057906144378890/friend.png");}

/* Connetions */
.connectedAccount-36nQx7 {
    border: solid #151b27;
    border-width: 1.2px 1.2px 3px 1.2px;
    border-radius: 4px;
    width: 300px;
    transition: 0.1s;
}
.connectedAccount-36nQx7:active {
    border-width: 1.2px 1.2px 1.2px 1.2px
    transform: translateY(1px);
    transition: 0.1s;
}

.connectedAccountIcon-3P3V6F { padding: 5px; border-radius: 4px;}
.connectedAccountName-f8AEe2 { margin-left: 13px;}
.accountBtnInner-sj5jLs[aria-label="Battle.net"], .accountBtnInner-sj5jLs[aria-label="Battle.net"]:hover, [src="/assets/4662875160dc4c56954003ebda995414.png"] { background-color: #1da0f248; }
.accountBtnInner-sj5jLs[aria-label="Twitch"], .accountBtnInner-sj5jLs[aria-label="Twitch"]:hover, [src="/assets/edbbf6107b2cd4334d582b26e1ac786d.png"] { background-color: #601bd852; }
.accountBtnInner-sj5jLs[aria-label="YouTube"], .accountBtnInner-sj5jLs[aria-label="YouTube"]:hover, [src="/assets/449cca50c1452b4ace3cbe9bc5ae0fd6.png"] { background-color: #d9252b49; }
.accountBtnInner-sj5jLs[aria-label="Twitter"], .accountBtnInner-sj5jLs[aria-label="Twitter"]:hover, [src="/assets/8c289d499232cd8e9582b4a5639d9d1d.png"] { background-color: #0098e446; }
.accountBtnInner-sj5jLs[aria-label="Steam"], .accountBtnInner-sj5jLs[aria-label="Steam"]:hover, [src="/assets/f09c1c70a67ceaaeb455d163f3f9cbb8.png"] { background-color: #00000034; }
.accountBtnInner-sj5jLs[aria-label="Reddit"], .accountBtnInner-sj5jLs[aria-label="Reddit"]:hover, [src="/assets/3abe9ce5a00cc24bd8aae04bf5968f4c.png"] { background-color:#fe44013d; }
.accountBtnInner-sj5jLs[aria-label="Facebook"], .accountBtnInner-sj5jLs[aria-label="Facebook"]:hover, [src="/assets/8d8f815f3d81a33b1e70ec7c22e1b6fe.png"] { background-color: #2e328485; }
.accountBtnInner-sj5jLs[aria-label="Spotify"], .accountBtnInner-sj5jLs[aria-label="Spotify"]:hover, [src="/assets/f0655521c19c08c4ea4e508044ec7d8c.png"] { background-color: #1ed75f34; }
.accountBtnInner-sj5jLs[aria-label="Xbox Live"], .accountBtnInner-sj5jLs[aria-label="Xbox Live"]:hover, [src="/assets/0d44ba28e39303de3832db580a252456.png"] { background-color: #5dc21e42; }
.accountBtnInner-sj5jLs[aria-label="League Of Legends"], .accountBtnInner-sj5jLs[aria-label="League Of Legends"]:hover, [src="/assets/806953fe1cc616477175cbcdf90d5cd3.png"] { background-color: #cea14638; }
.accountBtnInner-sj5jLs[aria-label="GitHub"], .accountBtnInner-sj5jLs[aria-label="GitHub"]:hover, [src="/assets/5d69e29f0d71aaa04ed9725100199b4e.png"] { background-color: #24292e62; }

/* -- USRBG Big Popout -- */
:root {
    --usrbg-modal-x-offset:-180px; /*Distance from the avatar container to the edge of the modal (x)*/
    --usrbg-modal-y-offset:-65px; /*Distance from the avatar container to the edge of the modal (y)*/
    --usrbg-modal-width:700px; /*Maximum width of modal*/
    --usrbg-modal-height:600px; /*Maximum height of modal*/
}
#app-mount .header-QKLPzZ .wrapper-3t9DeA[style*="width: 80px;"] {margin-right: 0 !important}
#app-mount .header-QKLPzZ .wrapper-3t9DeA[style*="width: 80px;"]::after {
    content:'';
    position:absolute;
    top:var(--usrbg-modal-x-offset) !important;
    left:var(--usrbg-modal-y-offset) !important;
    width:var(--usrbg-modal-width);
    height: var(--usrbg-modal-height);
    opacity:.7;
    pointer-events:none;
    background: var(--user-background) center/cover no-repeat;
    -webkit-mask: linear-gradient(#000000, #0000004f);
    mask: linear-gradient(#000, transparent);
}

.headerInfo-30uryT,
.tabBarItem-1b8RUP,
.activity-1ythUs { z-index:1; position:relative;}
/* --------------------------- 👤 USER SETTINGS --------------------------- */

/* Wide settings */
.contentRegion-3nDuYy { flex: 1 1 100%; }
.contentColumn-2hrIYH, .customColumn-Rb6toI, .sidebarScrollable-1qPI87 + .content-1rPSz4, .customScroller-26gWhv>div { max-width: 95%;}
.sidebar-CFHs9e { padding: 60px 0 35px 50px; width: 260px;}
.sidebar-CFHs9e > div > .item-PXvHYJ, #bd-settings-sidebar .ui-tab-bar-item { padding: 8px 0 8px 10px; margin-bottom: 0; border-radius: 5px 0 0 5px;}

/* My account */
.avatarUploaderIndicator-2G-aIZ { display: none;}

/* Connetions */
.connectionIcon-2ElzVe { border-radius: 5px; padding: 4px;}

/* Billing */
.theme-dark .paymentRow-2e7VM6, .theme-dark .pageActions-1SVAnA, .theme-dark .codeRedemptionRedirect-1wVR4b { background: var(--background-secondary-alt); }
.theme-dark .payment-xT17Mq:hover { background-color: var(--background-secondary);}
.theme-dark .expandedInfo-3kfShd { background: var(--background-secondary); }
.theme-dark .checked-3_4uQ9 { background: transparent; border-color: transparent;}
.theme-dark .bottomDivider-1K9Gao { border-bottom-color: transparent;}

/* Voice & Video */
.theme-dark .userSettingsVoice-iwdUCU .previewOverlay-2O7_KC { background: var(--background-secondary-alt);}

/* Game Activity */
.theme-dark .notDetected-33MY4s, .theme-dark .addGamePopout-2RY8Ju { background: var(--background-secondary-alt);}
.css-17e1tep-control { border: none;}

/* --------------------------- ⚙️ SERVER SETTINGS --------------------------- */

/* Modifications notification */
.noticeRegion-1YviSH { max-width: 1400px; right: 0;}
.container-2VW0UT { background: var(--background-tertiary) !important; }

/* Region selector */
.regionSelectModal-12e-57 { background: var(--background-secondary-alt) !important;}
.regionSelectModal-12e-57 .regionSelectModalOption-2DSIZ3 { background: var(--background-primary) !important; border: none;}

/* Roles */
.theme-dark .colorPickerCustom-2CWBn2 { background: var(--background-secondary); border-radius: 5px;}

/* Emoji */
.theme-dark .emojiAliasInput-1y-NBz .emojiInput-1aLNse { background: var(--background-secondary-alt);}
.theme-dark .card-FDVird:before { background: var(--background-secondary); border-color: transparent;}

/* Audit logs */
.theme-dark .headerClickable-2IVFo9, .theme-dark .headerDefault-1wrJcN, .theme-dark .headerExpanded-CUEwZ5 { background: var(--background-secondary-alt);}
.auditLog-3jNbM6 { border: none;}
.divider-1pnAR2 { display: none;}

/* Integrations */
.theme-dark .card-o7rAq-, .theme-dark .header-146Xl5 { border: none;}
.theme-dark .body-1zRX82, .theme-dark .cardPrimaryEditable-3KtE4g { background: var(--background-secondary); border: none;}

/* Overview */
.css-gvi9bl-control, .css-6fzn47-control { border: none;}
.theme-dark .css-3vaxre-menu { background: var(--background-secondary-alt); border: none; }

/* Welcome screen */
.descriptionInput-3b30C8 { background: var(--background-secondary-alt); border: none;}

/* Server Boost Status */
.theme-dark .tierBody-x9kBBp { background: var(--background-secondary); }
.theme-dark .tierHeaderContent-2-YfvN, .theme-dark .tierInProgress-3mBoXq { background: var(--background-secondary-alt); }
.theme-dark .background-3xPPFc { color: var(--background-secondary-alt); }

/* Members */
.theme-dark .overflowRolesPopout-140n9i{ background: var(--background-secondary); }

/* --------------------------- 🌺 OTHER --------------------------- */

/* -- Better menus -- */

/* Menu */
.menu-3sdvDG:hover > .scroller-3BxosC, .menu-3sdvDG { border-radius: 5px;}
.scroller-3BxosC { padding: 0;}

/* Submenu */
.submenuContainer-2gbm7M .layer-v9HyYc { margin: 0 -8px; }

/* Label */
.labelContainer-1BLJti.colorDefault-2K3EoJ:hover, .labelContainer-1BLJti.colorDefault-2K3EoJ.focused-3afm-j, .labelContainer-1BLJti.colorDefault-2K3EoJ:active:not(.hideInteraction-1iHO1O) { background-color: #5c6eb150;}
.labelContainer-1BLJti.colorDanger-2qLCe1:hover, .labelContainer-1BLJti.colorDanger-2qLCe1.focused-3afm-j, .labelContainer-1BLJti.colorDanger-2qLCe1:active:not(.hideInteraction-1iHO1O) { background-color: #f0474746;}

.scroller-3BxosC .labelContainer-1BLJti  {
    margin: 0;
    padding: 10px 15px;
    border-radius: 0;
    transition: 0.2s;
}

/* Label - Focus */
.scroller-3BxosC > div > .labelContainer-1BLJti.focused-3afm-j, .scroller-3BxosC > div > .labelContainer-1BLJti:active:not(.hideInteraction-1iHO1O) { border-radius: 0;}
.scroller-3BxosC > div:first-of-type > .labelContainer-1BLJti.focused-3afm-j:first-child, .scroller-3BxosC > .labelContainer-1BLJti.focused-3afm-j:first-child, .scroller-3BxosC > div:first-of-type > .labelContainer-1BLJti:active:not(.hideInteraction-1iHO1O):first-of-type { border-radius: 5px 5px 0 0;}
.scroller-3BxosC:not(.ring-13rgEW) > div:nth-last-of-type(2) > .labelContainer-1BLJti.focused-3afm-j:last-child, .scroller-3BxosC:not(.ring-13rgEW) > .labelContainer-1BLJti.focused-3afm-j:last-child, .scroller-3BxosC:not(.ring-13rgEW) > div:nth-last-of-type(2) > .labelContainer-1BLJti:active:not(.hideInteraction-1iHO1O):last-of-type,
.scroller-3BxosC > div:nth-last-of-type(3) > .labelContainer-1BLJti.focused-3afm-j:last-child, .scroller-3BxosC > .labelContainer-1BLJti.focused-3afm-j:last-child, .scroller-3BxosC > div:nth-last-of-type(3) > .labelContainer-1BLJti:active:not(.hideInteraction-1iHO1O):last-of-type { border-radius: 0 0 5px 5px;}

/* Coloured status when playing */
rect[mask="url(#svg-mask-status-online)"], rect[mask="url(#svg-mask-status-online-mobile)"] { fill: var(--online);}
rect[mask="url(#svg-mask-status-idle)"], rect[mask="url(#svg-mask-status-online-idle)"] { fill: var(--iddle);}
rect[mask="url(#svg-mask-status-dnd)"], rect[mask="url(#svg-mask-status-online-dnd)"] { fill: var(--dnd);}
rect[mask="url(#svg-mask-status-offline)"], rect[mask="url(#svg-mask-status-online-offline)"] { fill: var(--offline);}

/* Joining message */
.theme-dark .contentWrapper-3WC1ID { background: var(--background-secondary);}

/* Welcome message */
.root-1gCeng:not(.modal-qgFCbT) { background: var(--background-secondary);}

/* Deleting Discord watermark */
.wordmark-2iDDfm svg { display: var(--discord-logo);}

/* Watch stream popout */
.theme-dark .body-Ogsp8i { background: var(--background-tertiary);}

/* Deleting message confirmation */
.theme-dark .message-2qRu38 { background: var(--background-primary); }

/* Tooltips */
.tooltip-2QfLtc { display: var(--tooltips); background: var(--background-tertiary);}
.theme-dark .tooltipBlack-PPG47z .tooltipPointer-3ZfirK { border-top-color: var(--background-tertiary);}

/* Keyboard shortcuts */
.theme-dark .keyboardShortcutsModal-3piNz7 { background: var(--background-primary); }
.theme-dark .keybindShortcut-1BD6Z1 span { border-radius: 1px;}

/* Discord games */
.theme-dark .scroller-1JpcIc { background: var(--background-primary);}
.theme-dark .whyYouMightLikeIt-2zZIIj, .theme-dark .content-35aVm0, .theme-dark .bodySection-jqkkIP, .theme-dark .row-1bU71H { background: var(--background-secondary);}

/* Popups */
.theme-dark .root-1gCeng, .theme-dark .footer-2gL1pp, .theme-dark .modal-yWgWj- { box-shadow: none;}

/* Cross */
.theme-dark .default-3oAQTF, .theme-dark .default-3oAQTF:hover { background-color: var(--background-tertiary);}

/* >:( NO borders */
.theme-dark .messageGroupWrapper-o-Zw7G, .theme-dark .inputDefault-_djjkz, .theme-dark .container-1nZlH6, .theme-dark .cardPrimary-1Hv-to,
.theme-dark .cardPrimaryOutline-29Ujqw, .theme-dark .codeRedemptionRedirect-1wVR4b, .theme-dark .previewOverlay-2O7_KC, .theme-dark .markup-2BOw-j code { border: none;}

/* PermisssionViewer support,*/
#permissions-modal-wrapper #permissions-modal { box-shadow: none !important; border: none !important;}
#permissions-modal-wrapper .header { background: var(--background-tertiary) !important; text-align: center !important;}
#permissions-modal-wrapper .role-side, #permissions-modal-wrapper .perm-side {background: var(--background-secondary) !important;}

/* Reaction popout */
.theme-dark .scroller-1-nKid { background: var(--background-tertiary); }
.theme-dark .container-1If-HZ, .theme-dark .reactors-Blmlhw { background: var(--background-secondary);}
.reactionSelected-1pqISm, .reactionDefault-GBA58K:hover { margin-right: 6px;}
.theme-dark .reactionSelected-1pqISm { background-color: #297EC021; }

/* Spotify session */
.theme-dark .invite-18yqGF { background-color: var(--background-secondary); border-color: transparent;}

/* Attachement */
.attachment-33OFj0 { border: none;}

/* Spotify embed */
.embedSpotify-tvxDCr { border-radius: 5px;}

/* Discord Gift */
.theme-dark .tile-2OwFgW { background-color: var(--background-secondary);}
.theme-dark .tileHorizontal-3eee4N.tile-2OwFgW:hover { background-color: var(--background-secondary-alt);}
.theme-dark .invalidPoop-pnUbq7 { background-color: rgba(0, 0, 0, 0.103);}

/* Spoiler */
.theme-dark .spoilerText-3p6IlD.hidden-HHr2R9, .theme-dark .spoilerText-3p6IlD.hidden-HHr2R9:hover { background-color: var(--background-secondary-alt);}

/* Audio player */
.theme-dark .wrapperAudio-1jDe0Q { padding: 10px 0 0 0; border-color: transparent;}
.theme-dark .audioMetadata-3zOuGv { padding: 5px 10px;}
.theme-dark .audioControls-2HsaU6 { border-radius: 0;}

/* HLJS Support */
.hljs.scrollbar-3dvm_9 { background-color: var(--background-secondary) !important;}

/* SCTR connection */
.theme-dark .container-2x5lvQ .header-2C89wJ { background-color: var(--background-tertiary); }
.theme-dark .container-2x5lvQ section { background-color: var(--background-secondary); }

/* Member Count support */
.theme-dark #MemberCount { background-color: var(--background-secondary) !important;}

/* Comfy camp server */
[src="https://cdn.discordapp.com/icons/811203761619337259/0564a75bda132490421a8d4cccb0ea1c.webp?size=128"] { content: url('https://cdn.discordapp.com/attachments/819755030454337537/823568767434489936/compressed_cat.gif');}
.listItem-2P_4kh:hover .icon-27yU2q[src*="https://cdn.discordapp.com/icons/811203761619337259/0564a75bda132490421a8d4cccb0ea1c"] { content: url('https://cdn.discordapp.com/attachments/819755030454337537/823568767434489936/compressed_cat.gif');}
[href="/channels/811203761619337259/811646287161720842"] > div > svg > path, [href="/channels/811203761619337259/811203762147426347"] > div > svg > path { d: path("M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"); transform: scale(1.5);}
[href="/channels/811203761619337259/811639729144463410"] > div > svg > path { d: path("M8 17v-6h4v6h5V9h3L10 0 0 9h3v8z"); transform: scale(1.2);}
[href="/channels/811203761619337259/811649421884260382"] > div > svg > path { d: path("M22 12L12.101 2.10101L10.686 3.51401L12.101 4.92901L7.15096 9.87801V9.88001L5.73596 8.46501L4.32196 9.88001L8.56496 14.122L2.90796 19.778L4.32196 21.192L9.97896 15.536L14.222 19.778L15.636 18.364L14.222 16.95L19.171 12H19.172L20.586 13.414L22 12Z");}
[href="/channels/811203761619337259/812834431424397324"] > div > svg > path { d: path("m16 7.6c0 .79-1.28 1.38-1.52 2.09s.44 2 0 2.59-1.84.35-2.46.8-.79 1.84-1.54 2.09-1.67-.8-2.47-.8-1.75 1-2.47.8-.92-1.64-1.54-2.09-2-.18-2.46-.8.23-1.84 0-2.59-1.54-1.3-1.54-2.09 1.28-1.38 1.52-2.09-.44-2 0-2.59 1.85-.35 2.48-.8.78-1.84 1.53-2.12 1.67.83 2.47.83 1.75-1 2.47-.8.91 1.64 1.53 2.09 2 .18 2.46.8-.23 1.84 0 2.59 1.54 1.3 1.54 2.09z");transform: scale(1.5);}
[href="/channels/811203761619337259/811648374687399988"] > div > svg > path { d: path("M4.79805 3C3.80445 3 2.99805 3.8055 2.99805 4.8V15.6C2.99805 16.5936 3.80445 17.4 4.79805 17.4H7.49805V21L11.098 17.4H19.198C20.1925 17.4 20.998 16.5936 20.998 15.6V4.8C20.998 3.8055 20.1925 3 19.198 3H4.79805Z");transform: scale(1.1);}
[href="/channels/811203761619337259/811645185112801341"] > div > svg > path { d: path("M15,15H3V13H15Zm0-4H3V9H15Zm0-4H3V5H15ZM0,20l1.5-1.5L3,20l1.5-1.5L6,20l1.5-1.5L9,20l1.5-1.5L12,20l1.5-1.5L15,20l1.5-1.5L18,20V0L16.5,1.5,15,0,13.5,1.5,12,0,10.5,1.5,9,0,7.5,1.5,6,0,4.5,1.5,3,0,1.5,1.5,0,0Z");transform: translate(3.5px, 2px);}
[href="/channels/811203761619337259/820232999878393856"] > div > svg > path { d: path("M17,13.6 L17.3999992,13.6 C19.0406735,13.6 20.496781,12.8097754 21.4084757,11.5891722 L21.8198761,18.8298199 C21.913864,20.4840062 20.6490733,21.9011814 18.994887,21.9951692 C18.9382174,21.9983891 18.8814679,22 18.8247069,22 L5.1752931,22 C3.51843885,22 2.1752931,20.6568542 2.1752931,19 C2.1752931,18.943239 2.17690401,18.8864895 2.18012387,18.8298199 L2.59152425,11.5891732 C3.503219,12.8097758 4.95932613,13.6 6.6,13.6 L7,13.6 L7,15 L9,15 L9,13.6 L15,13.6 L15,15 L17,15 L17,13.6 Z M7,16 L7,18 L9,18 L9,16 L7,16 Z M15,16 L17,16 L17,18 L15,18 L15,16 Z M15,11.6 L9,11.6 L9,9 L7,9 L7,11.6 L6.6,11.6 C4.94314575,11.6 3.6,10.2568542 3.6,8.6 L3.6,5 C3.6,3.34314575 4.94314575,2 6.6,2 L17.3999992,2 C19.0568535,2 20.3999992,3.34314575 20.3999992,5 L20.3999992,8.6 C20.3999992,10.2568542 19.0568535,11.6 17.3999992,11.6 L17,11.6 L17,9 L15,9 L15,11.6 Z");transform: scale(1.1);}
[href="/channels/811203761619337259/820235200528908289"] > div > svg > path { d: path("M20.259,3.879c-1.172-1.173-3.07-1.173-4.242,0l-8.753,8.753c1.111-0.074,2.247,0.296,3.096,1.146 s1.22,1.985,1.146,3.097l8.754-8.755C20.822,7.559,21.138,6.796,21.138,6C21.138,5.204,20.822,4.442,20.259,3.879z M3.739,15.193C0.956,17.976,4.12,19.405,1,22.526c0,0,5.163,0.656,7.945-2.127 c1.438-1.438,1.438-3.769,0-5.207C7.507,13.755,5.176,13.755,3.739,15.193z");}
[href="/channels/811203761619337259/811644977637621760"] > div > svg > path { d: path("M14.25 14.25H3.75V3.75h7.5v-1.5h-7.5c-.8325 0-1.5.6675-1.5 1.5v10.5c0 .8284271.67157288 1.5 1.5 1.5h10.5c.8284271 0 1.5-.6715729 1.5-1.5v-6h-1.5v6zM6.6825 7.31L5.625 8.375 9 11.75l7.5-7.5-1.0575-1.065L9 9.6275 6.6825 7.31z"); transform: scale(1.4);}

/* -- Avatar customization -- */
.pointerEvents-2zdfdO { mask: none !important; rx: var(--status-radius);}
[mask*="mobile)"], [mask="url(#svg-mask-status-typing)"]{ rx: var(--status-radius);}
.avatarHint-1qgaV3 { display: none;}
.mask-1l8v16 { overflow: visible;}
.userPopout-3XzG_A .pointerEvents-2zdfdO { x: 67; y: 67;}
.members-1998pB .pointerEvents-2zdfdO, .panels-j1Uci_ .pointerEvents-2zdfdO { x: 24; y: 24;}
[id="5086f76c-5cbe-4ce5-aa54-3cd59707d1b6"] > rect { rx: var(--status-radius);}
[id="5086f76c-5cbe-4ce5-aa54-3cd59707d1b6"] > rect:nth-child(2) { display: none;}

/* Avatars radius */
.wrapper-3t9DeA foreignObject, .callAvatarMask-1SLlRi foreignObject, .avatarContainer-3CQrif foreignObject { mask: none;}
.wrapper-3t9DeA, .avatar-1BDn8e, .profile-1eT9hT .avatarUploaderInner-3UNxY3, .voiceAvatar-14IynY, .avatar-3tNQiO,
.border-Jn5IOt, .avatar-3bWpYy, .clickableAvatar-1wQpeh, .emptyUser-7txhlW, .avatar-VxgULZ,
.wrapper-2QE8vf.ringingIncoming-38YcLn:after, .wrapper-2QE8vf.ringingOutgoing-mbXhhQ:after { border-radius: 5px;}

/* Server radius */
.wrapper-25eVIn foreignObject, .folderIconWrapper-226oVY, .expandedFolderBackground-2sPsd-,
.icon-3o6xvg, .flexChild-faoVW3 .avatarUploaderInner-3UNxY3 { border-radius: var(--server-radius); mask: none;}
.wrapper-25eVIn foreignObject { transition: 0.2s;}
.wrapper-25eVIn:hover foreignObject { border-radius: calc(var(--server-radius) - 3px); transition: 0.2s;}

/* Powercord update toast */
.powercord-toast { border: none;}
.powercord-toast > .buttons > .lookOutlined-3sRXeN.colorGrey-2DXtkV { color: #fff; border: none;}

/* Vizality connections plugin support */
.ud-connections > div > img { border-radius: 5px; padding: 3px; margin: 3px;}

/* Vizality support */
.channel-2QD9_O { max-width: unset;}
[href="/vizality"], .vz-dashboard-sidebar-item, .vz-dashboard-sidebar-subitem.categoryItem-3zFJns { margin-left: 0;}
.vz-dashboard-sidebar-subitem-inner.layout-2DM8Md { padding: 12px !important;}
.vz-dashboard-sidebar-item-inner.layout-2DM8Md { padding: 5px 8px !important;}
.vz-c-settings-item { background: var(--background-secondary);}
.vz-c-settings-category-title, .vz-c-settings-category-title[vz-opened] { background: var(--background-secondary-alt);}
.vz-toast-buttons .lookOutlined-3sRXeN.colorGrey-2DXtkV { color: #fff; border: none;}

/* Vizality Connections plugin */
.ud-connections > div { border-radius: 5px; margin-right: 3px;}

/* Buttons */
.container-3auIfb, .input-rwLH4i { border-radius: 5px;}
.slider-TkfMQL rect { rx: 5px;}
:root {
--sizelg:1.25rem;
	--size0: 1.15rem;
	--size1: .925rem;
	--size2: .8rem;
	--size3: .75rem;
	--size4: .7rem;
	--size5: .5rem;
	--size6: .35rem;

    --SD-bgR: 10; /* RED value | 0 - 255 | DEFAULT: 10 */
    --SD-bgG: 10; /* GREEN value | 0 - 255 | DEFAULT: 10 */
    --SD-bgB: 10; /* BLUE value | 0 - 255 | DEFAULT: 10 */


    --SD-accent: 33,150,243;


    --SD-font: 'Roboto';
  --bg1: rgba( var(--SD-bgR), var(--SD-bgG), var(--SD-bgB), 1);
  --bg2: rgba( calc(var(--SD-bgR) * 1.5), calc(var(--SD-bgG) * 1.5), calc(var(--SD-bgB) * 1.5), 1);
  --bg3: rgba( calc(var(--SD-bgR) * 2), calc(var(--SD-bgG) * 2), calc(var(--SD-bgB) * 2), 1);
  --bg4: rgba( calc(var(--SD-bgR) * 2.5), calc(var(--SD-bgG) * 2.5), calc(var(--SD-bgB) * 2.5), 1);
  --bg5: rgba( calc(var(--SD-bgR) * 3), calc(var(--SD-bgG) * 3), calc(var(--SD-bgB) * 3), 1);
  --bg6: rgba( calc(var(--SD-bgR) * 3.5), calc(var(--SD-bgG) * 3.5), calc(var(--SD-bgB) * 3.5), 1);
  --bg7: rgba( calc(var(--SD-bgR) * 4), calc(var(--SD-bgG) * 4), calc(var(--SD-bgB) * 4), 1);
  --bg8: rgba( calc(var(--SD-bgR) * 4.5), calc(var(--SD-bgG) * 4.5), calc(var(--SD-bgB) * 4.5), 1);
  --bg9: rgba( calc(var(--SD-bgR) * 5), calc(var(--SD-bgG) * 5), calc(var(--SD-bgB) * 5), 1);
  --bg10: rgba( calc(var(--SD-bgR) * 5.5), calc(var(--SD-bgG) * 5.5), calc(var(--SD-bgB) * 5.5), 1);
  --bg11: rgba( calc(var(--SD-bgR) * 6), calc(var(--SD-bgG) * 6), calc(var(--SD-bgB) * 6), 1);
  --bg12: rgba( calc(var(--SD-bgR) * 6.5), calc(var(--SD-bgG) * 6.5), calc(var(--SD-bgB) * 6.5), 1);
  --bg13: rgba( calc(var(--SD-bgR) * 7), calc(var(--SD-bgG) * 7), calc(var(--SD-bgB) * 7), 1);
  --bg14: rgba( calc(var(--SD-bgR) * 7.5), calc(var(--SD-bgG) * 7.5), calc(var(--SD-bgB) * 7.5), 1);
  --bg15: rgba( calc(var(--SD-bgR) * 8), calc(var(--SD-bgG) * 8), calc(var(--SD-bgB) * 8), 1);
  --SD-accent-default: 33,150,243;
  --SD-accent-set: var(--SD-accent, var(--SD-accent-default));
  --text-link: rgba(var(--SD-accent-set), 1);
  --green: #43b581;a
  --greenDark: #359066;
  --yellow: #faa61a;
  --yellowDark: #dc8b05;
  --red: #f04747;
  --redDark: #b63b3b;
  --purple: #593695;
  --purpleDark: #432870;
  --blurple: #297EC0;
  --nitro: #ff73fa;
  --TB-position-top: calc(var(--server-size) + 20px) ;
}
#app-mount .wrapper-3t9DeA[aria-label*=mobile]:after {
  content: "";
  -webkit-mask: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij4gICAgPHBhdGggZD0iTTE1LjUgMWgtOEM2LjEyIDEgNSAyLjEyIDUgMy41djE3QzUgMjEuODggNi4xMiAyMyA3LjUgMjNoOGMxLjM4IDAgMi41LTEuMTIgMi41LTIuNXYtMTdDMTggMi4xMiAxNi44OCAxIDE1LjUgMXptLTQgMjFjLS44MyAwLTEuNS0uNjctMS41LTEuNXMuNjctMS41IDEuNS0xLjUgMS41LjY3IDEuNSAxLjUtLjY3IDEuNS0xLjUgMS41em00LjUtNEg3VjRoOXYxNHoiLz4gICAgPHBhdGggZD0iTTAgMGgyNHYyNEgweiIgZmlsbD0ibm9uZSIvPjwvc3ZnPg==");
  -webkit-mask-size: 16px;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  display: block;
  position: absolute;
  width: 12px;
  height: 16px;
  top: 50%;
  transform: translateY(-50%);
  right: -185px;
  background: var(--blurple);
  z-index: 1;
}

@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
@import url("https://discordstyles.github.io/MinimalCord/base.css");

:root {
    /*
        Accent variable
        Use this website: https://htmlcolorcodes.com/color-picker/
        to get your desired RGB numbers. Then simply put each number in their respective area.
        R,G,B
    */
    --accent: 50, 131, 207;

    --message-padding: 10px; /* Spacing in the messages. MUST END IN px | DEFAULT: 10px */
    --message-spacing: 10px; /* Spacing around the messages. MUST END IN px | DEFAULT: 10px */

    /*
        To use a custom font. Visit https://fonts.google.com and select one to your liking.
        Now just follow this tutorial: https://imgur.com/a/CNbw7xC
    */
    --font: 'Roboto';
}
:root {
  --border-radius: 5px;
  --discord-green: 67 181 129;
  --discord-yellow: 219 171 9;
  --discord-red: 215 58 73;
  --discord-purple: 89 54 149;
  --discord-invisible: 117 128 142;
  --discord-nitro: 255 115 250;
  --discord-blurple: 114 137 218;
  --discord-spotify: 29 185 84;
  --discord-twitch: 89 54 149;
  --discord-xbox: 16 124 16;
  --background-modifier-selected: var(--background-light);
  --background-modifier-hover: var(--background-alt);
  --background-modifier-active: var(--background-light);
  --channels-default: var(--text-normal);
  --version: "2.0.7";
}

.theme-light {
  --background-light: #fff;
  --background-light-alt: #fff;
  --background: #edf2f7;
  --background-alt: #f7fafc;
  --background-dark: #e2e8f0;
  --text-normal: #2d3748;
  --text-muted: #718096;
  --text-focus: #1a202c;
  --font-weight-light: 400;
  --font-weight-normal: 500;
  --font-weight-semibold: 700;
  --font-weight-bold: 700;
  --box-shadow: 0 4px 9px rgba(0 0 0 / 0.2);
  --box-shadow-alt: 0 2px 5px rgba(0 0 0 / 0.1);
  --scrollbar-colour: rgba(0 0 0 / 0.2);
  --edit-message-box: var(--background-light);
  --message-background: var(--background-light);
}

.theme-dark {
  --background-light: #1D232E;
  --background-light-alt: #1f2329;
  --background: #11161F;
  --background-alt: #171C25;
  --background-dark: #0D1119;
  --text-normal: #d1d1d2;
  --text-muted: #686a6d;
  --text-focus: #fff;
  --font-weight-light: 300;
  --font-weight-normal: 400;
  --font-weight-semibold: 500;
  --font-weight-bold: 700;
  --box-shadow: 0 4px 9px rgba(0 0 0 / 0.4);
  --box-shadow-alt: 0 2px 5px rgba(0 0 0 / 0.3);
  --scrollbar-colour: var(--background-light);
  --edit-message-box: var(--background-light);
  --message-background: var(--background-alt);
}

#app-mount .bg-h5JY_x {
  background: var(--background-dark);
}

::selection {
  background: rgba(var(--accent), 1);
  color: #fff;
}

::-webkit-input-placeholder, body, button, input, select, textarea {
  font-family: var(--font, "Roboto"), "Whitney";
}

html, span:not([class*=spinner-]):not([class*=spinnerItem]) {
  -webkit-backface-visibility: hidden !important;
          backface-visibility: hidden !important;
}

#app-mount .title-3qD0b-,
#app-mount .container-1r6BKw {
  background: var(--background);
}
#app-mount .children-19S4PO:after {
  content: none;
}
#app-mount .searchBar-3dMhjb {
  background: var(--background-dark);
}

::-webkit-scrollbar {
  width: 8px !important;
  height: 8px !important;
}

::-webkit-scrollbar,
::-webkit-scrollbar-track,
::-webkit-scrollbar-track-piece {
  border-color: transparent !important;
  background: transparent !important;
}

::-webkit-scrollbar-thumb {
  border-radius: var(--border-radius) !important;
  border: none !important;
  background-clip: content-box !important;
  background: var(--scrollbar-colour) !important;
}

::-webkit-scrollbar-corner {
  visibility: hidden !important;
}

.scrollerThemed-2oenus.themeHidden-2yP93k .scroller-2FKFPG::-webkit-scrollbar,
.scrollerThemed-2oenus.themeHidden-2yP93k .scroller-2FKFPG::-webkit-scrollbar-corner,
.scrollerThemed-2oenus.themeHidden-2yP93k .scroller-2FKFPG::-webkit-scrollbar-thumb,
.scrollerThemed-2oenus.themeHidden-2yP93k .scroller-2FKFPG::-webkit-scrollbar-track {
  display: none !important;
}

.scroller-1JbKMe,
.scroller-305q3I {
  background: transparent;
}

#app-mount .tooltipPrimary-1d1ph4 {
  background: var(--background-light);
  box-shadow: var(--box-shadow);
}
#app-mount .tooltipPointer-3ZfirK {
  border-top-color: var(--background-light);
}
#app-mount .tooltipContent-bqVLWK {
  color: var(--text-focus);
  font-weight: var(--font-weight-bold);
}

#app-mount .info-1VyQPT .colorMuted-HdFt4q:first-child:before {
  content: "MinimalCord " var(--version) " [BETA]";
  display: block;
}

#app-mount .guilds-1SWlCJ {
  background: var(--background-dark);
}
#app-mount .guilds-1SWlCJ .scroller-2TZvBN {
  background: var(--background-dark);
}
#app-mount .guilds-1SWlCJ .scroller-2TZvBN::-webkit-scrollbar {
  display: none;
}

#app-mount .wrapper-1BJsBx.selected-bZ3Lue .childWrapper-anI2G9 {
  background: rgb(var(--accent), 1);
}
#app-mount .childWrapper-anI2G9 {
  background: var(--background-light);
}
#app-mount .circleIconButton-jET_ig {
  background: var(--background-light);
}
#app-mount .circleIconButton-jET_ig:hover {
  background: rgb(var(--discord-green)/1);
}

#app-mount .expandedFolderBackground-2sPsd- {
  z-index: -1;
  background: var(--background-light);
}
#app-mount .folder-21wGz3 {
  background: var(--background-light);
}

#app-mount .container-3w7J-x,
#app-mount .sidebar-2K8pFh {
  background: var(--background);
}

#app-mount .panels-j1Uci_ {
  background: var(--background);
}
#app-mount .container-1giJp5 {
  border: none;
}

#app-mount .wrapper-2jXpOf {
  height: auto;
  margin-bottom: 2px;
}
#app-mount .wrapper-2jXpOf.modeMuted-onO3r- .name-23GUGE {
  color: var(--text-muted);
}
#app-mount .wrapper-2jXpOf.modeUnread-1qO3K1 .icon-1DeIlz {
  color: var(--text-focus);
}
#app-mount .wrapper-2jXpOf.modeSelected-346R90 .icon-1DeIlz {
  color: var(--text-focus);
}
#app-mount .wrapper-2jXpOf.modeSelected-346R90:before {
  content: "";
  position: absolute;
  top: 1px;
  height: calc(100% - 2px);
  width: 4px;
  background: rgb(var(--accent), 1);
  z-index: 1;
}
#app-mount .content-1x5b-n {
  margin-left: 0;
  border-radius: 0 var(--border-radius) var(--border-radius) 0;
  padding-left: 16px;
}
#app-mount .unread-2lAfLh {
  z-index: 2;
}
#app-mount .avatarSpeaking-2IGMRN {
  box-shadow: inset 0 0 0 2px rgba(var(--accent), 1), inset 0 0 0 3px var(--background);
}

#app-mount .selected-31Nl7x .header-2V-4Sw {
  background: transparent;
}
#app-mount .header-2V-4Sw {
  box-shadow: none;
}
#app-mount .header-2V-4Sw:hover {
  background: transparent;
}

#app-mount .sidebar-2K8pFh .bar-30k2ka {
  border-radius: var(--border-radius);
  background: var(--background-light);
  box-shadow: var(--box-shadow);
}

#app-mount .chat-3bRxxu {
  background: var(--background);
}
#app-mount .chat-3bRxxu .scrollerSpacer-avRLaA {
  height: 25px;
}
#app-mount .chat-3bRxxu .content-yTz4x3:before {
  content: none;
}
#app-mount .operations-36ENbA > a {
  color: rgb(var(--accent), 1);
}

#app-mount .form-2fGMdU:before {
  content: none;
}
#app-mount .scrollableContainer-2NUZem {
  background: var(--background-alt);
  box-shadow: var(--box-shadow);
  border-radius: var(--border-radius);
}
#app-mount .placeholder-37qJjk {
  text-transform: uppercase;
  font-weight: bold;
  letter-spacing: 1.5px;
  font-size: 12px;
}
#app-mount .placeholder-37qJjk,
#app-mount .slateTextArea-1Mkdgw {
  padding: 15px;
}
#app-mount .attachButton-2WznTc {
  padding: 15px 16px;
  height: 52px;
}
#app-mount .buttons-3JBrkn {
  height: 52px;
}

#app-mount .message-2qnXI6 .scrollableContainer-2NUZem {
  background: var(--edit-message-box);
  box-shadow: none;
}
#app-mount .cozy-3raOZG {
  background: transparent;
  padding-top: var(--message-padding);
  padding-bottom: var(--message-padding);
  padding-left: 0;
  margin-left: 16px;
  margin-right: 8px;
  position: relative;
}
#app-mount .cozy-3raOZG:before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: var(--message-border-radius, var(--border-radius));
  background: var(--background-alt);
  z-index: -1;
}
#app-mount .cozy-3raOZG .contents-2mQqc9,
#app-mount .cozy-3raOZG .container-1ov-mD {
  margin-left: calc(40px + (var(--message-padding) * 2));
}
#app-mount .cozy-3raOZG .avatar-1BDn8e {
  left: var(--message-padding);
  top: var(--message-padding);
  margin-top: 0;
}
#app-mount .cozy-3raOZG.groupStart-23k01U {
  margin-top: var(--message-spacing);
}
#app-mount .cozy-3raOZG + .cozy-3raOZG:not(.groupStart-23k01U) {
  margin-top: calc(var(--message-padding) / -1);
  padding-top: 0.175rem;
}
#app-mount .cozy-3raOZG .messageContent-2qWWxC {
  margin-left: -5px;
  padding-left: 5px;
}
#app-mount .cozy-3raOZG .wrapper-2aW0bm {
  background: var(--background-light);
  height: 24px;
  box-shadow: var(--box-shadow-alt);
}
#app-mount .cozy-3raOZG .button-1ZiXG9 {
  height: 24px;
  width: 24px;
  padding: 0;
}
#app-mount .cozy-3raOZG .button-1ZiXG9 svg {
  width: 14px;
  height: 14px;
}
#app-mount .cozy-3raOZG .button-1ZiXG9:hover {
  background: rgba(var(--accent), 1);
  color: #fff;
}
#app-mount .cozy-3raOZG .button-1ZiXG9.dangerous-2r8KxV:hover {
  background: rgba(var(--discord-red)/1);
}
#app-mount .cozy-3raOZG .timestamp-3ZCmNB.alt-1uNpEt {
  width: calc(40px + var(--message-padding));
  display: flex;
  justify-content: center;
}
#app-mount .cozy-3raOZG.mentioned-xhSam7 .messageContent-2qWWxC {
  position: relative;
}
#app-mount .cozy-3raOZG.mentioned-xhSam7 .messageContent-2qWWxC:after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 0 var(--border-radius) 0 0;
  height: 100%;
  width: calc(100% - var(--message-padding));
  border-left: 2px solid rgba(var(--discord-yellow)/1);
  background: var(--background-mentioned);
  pointer-events: none;
}
#app-mount .cozy-3raOZG.mentioned-xhSam7 .container-1ov-mD {
  position: relative;
}
#app-mount .cozy-3raOZG.mentioned-xhSam7 .container-1ov-mD:before {
  content: "";
  position: absolute;
  pointer-events: none;
  top: 0;
  left: -5px;
  height: 100%;
  width: calc(100% - var(--message-padding) + 5px);
  border-left: 2px solid rgba(var(--discord-yellow)/1);
  background: var(--background-mentioned);
  border-radius: 0 0 var(--border-radius) 0;
}
#app-mount .cozy-3raOZG .repliedMessage-VokQwo {
  margin-left: calc(var(--message-padding) + 56px);
}
#app-mount .cozy-3raOZG .repliedMessage-VokQwo + .contents-2mQqc9 .avatar-1BDn8e, #app-mount .cozy-3raOZG .repliedMessage-VokQwo + .contents-2mQqc9 img {
  top: 32px;
}
#app-mount .cozy-3raOZG .repliedMessage-VokQwo:before {
  border-color: var(--text-muted);
}
#app-mount .hljs-comment {
  color: var(--text-muted);
}
#app-mount .wrapper-3WhCwL {
  background: rgba(var(--accent), 0.1);
  color: rgba(var(--accent), 1);
}
#app-mount .wrapper-3WhCwL:hover, #app-mount .wrapper-3WhCwL.popout-open {
  background: rgba(var(--accent), 1);
  color: #fff;
}
#app-mount .wrapper-3vR61M {
  background: transparent;
}
#app-mount .wrapper-1F5TKx {
  background: transparent;
  padding-top: var(--message-padding);
  padding-bottom: var(--message-padding);
  padding-left: 0;
  margin-left: 16px;
  margin-right: 8px;
  position: relative;
}
#app-mount .wrapper-1F5TKx:before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: var(--message-border-radius, var(--border-radius));
  background: var(--background-alt);
  z-index: -1;
}
#app-mount .wrapper-1F5TKx .contents-1R-xLu,
#app-mount .wrapper-1F5TKx .attachmentContainer-2BK1nK {
  padding-left: calc(40px + (var(--message-padding) * 2));
}
#app-mount .wrapper-1F5TKx .avatar-1BDn8e {
  left: var(--message-padding);
  top: var(--message-padding);
  margin-top: 0;
}
#app-mount .wrapper-1F5TKx[style*=margin-top] {
  margin-top: var(--message-spacing) !important;
}
#app-mount .wrapper-1F5TKx + .wrapper-1F5TKx:not([style*=margin-top]) {
  margin-top: calc(var(--message-padding) / -1);
  padding-top: 0.175rem;
}
#app-mount .embedFull-2tM8-- {
  background: var(--background-dark);
}
#app-mount .attachment-33OFj0,
#app-mount .wrapperAudio-1jDe0Q {
  background: var(--background-dark);
  border-radius: var(--border-radius);
  border: none;
}
#app-mount pre code,
#app-mount code.inline {
  background: var(--background-dark);
  border-radius: var(--border-radius);
  border: none;
}

#app-mount .divider-JfaTT5.isUnread-3Ef-o9 {
  margin: calc(var(--message-padding) / -1 - 1px) 8px calc(var(--message-padding) / -1) calc(55px + (var(--message-padding) * 2));
  height: 0;
  top: 0;
}
#app-mount .divider-JfaTT5.isUnread-3Ef-o9.beforeGroup-1rH1F0 {
  margin: var(--message-spacing) 8px var(--message-spacing) 20px;
}
#app-mount .divider-JfaTT5.hasContent-1cNJDh {
  margin: var(--message-spacing) 0 var(--message-spacing) 20px;
}
#app-mount .divider-JfaTT5.hasContent-1cNJDh .content-1o0f9g {
  background: var(--background-light);
  padding: 4px 8px;
  line-height: normal;
  font-weight: var(--font-weight-semibold);
  border-radius: var(--border-radius);
}
#app-mount .divider-JfaTT5.hasContent-1cNJDh:not(.isUnread-3Ef-o9) {
  border-top: none;
  height: auto;
}
#app-mount .divider-JfaTT5.hasContent-1cNJDh:not(.isUnread-3Ef-o9):before {
  content: "";
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 100%;
  background: var(--background-light);
  height: 1px;
  z-index: -1;
}

#app-mount .newMessagesBar-265mhP {
  background: rgba(var(--accent), 1);
  border-radius: var(--border-radius);
  top: 10px;
  left: 26px;
  right: 26px;
}
#app-mount .jumpToPresentBar-G1R9s6 {
  background: var(--background-light);
  opacity: 1;
  border-radius: var(--border-radius);
  left: auto;
  box-shadow: var(--box-shadow);
  bottom: 20px;
  padding-bottom: 0;
}
#app-mount .jumpToPresentBar-G1R9s6 .barButtonMain-3K-jeJ {
  display: none;
}
#app-mount .jumpToPresentBar-G1R9s6 .barButtonBase-2uLO1z {
  padding: 10px;
  height: auto;
  line-height: normal;
}
#app-mount .jumpToPresentBar-G1R9s6 .spinner-1AwyAQ {
  padding-left: 12px;
}

#app-mount .members-1998pB {
  background: transparent;
}
#app-mount .members-1998pB > div {
  background: transparent;
}

#app-mount .member-3-YXUe .botTagRegular-2HEhHi {
  background: rgba(var(--accent), 1);
}
#app-mount .member-3-YXUe:hover .layout-2DM8Md {
  background: var(--background-alt);
}
#app-mount .member-3-YXUe:active .layout-2DM8Md {
  background: var(--background-light);
}
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md {
  background: rgba(var(--accent), 1);
}
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md .roleColor-rz2vM0,
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md .activity-2Gy-9S,
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md .premiumIcon-1rDbWQ {
  color: #fff !important;
}
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md rect[fill="#43b581"],
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md rect[fill="#FD6F6F"],
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md rect[fill="#f04747"] {
  fill: #fff;
}
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md .botTagRegular-2HEhHi {
  background: #fff;
  color: rgba(var(--accent), 1);
}

#app-mount .userPopout-3XzG_A {
  box-shadow: var(--box-shadow);
  border-radius: var(--border-radius);
}
#app-mount .userPopout-3XzG_A .headerTag-2pZJzA,
#app-mount .userPopout-3XzG_A .headerText-1HLrL7,
#app-mount .userPopout-3XzG_A .content-3JfFJh,
#app-mount .userPopout-3XzG_A .text-AOoUen,
#app-mount .userPopout-3XzG_A .customStatus-1bh2V9,
#app-mount .userPopout-3XzG_A .headerTagUsernameNoNickname-2_H881 {
  color: var(--text-normal);
}
#app-mount .userPopout-3XzG_A .activityName-1IaRLn,
#app-mount .userPopout-3XzG_A .nameNormal-2lqVQK,
#app-mount .userPopout-3XzG_A .nameWrap-3Z4G_9 {
  color: var(--text-focus);
}
#app-mount .userPopout-3XzG_A .headerNormal-T_seeN {
  background: var(--background);
}
#app-mount .userPopout-3XzG_A .activity-11LB_k {
  background: rgba(0, 0, 0, 0.025);
}
#app-mount .userPopout-3XzG_A .body-3iLsc4 {
  background: var(--background-alt);
}
#app-mount .userPopout-3XzG_A .footer-1fjuF6 {
  background: var(--background-alt);
  padding-bottom: 0;
}
#app-mount .userPopout-3XzG_A .note-3HfJZ5 {
  margin: 0;
}
#app-mount .userPopout-3XzG_A .textarea-2r0oV8:focus {
  background: var(--background-dark);
}
#app-mount .userPopout-3XzG_A .input-2_SIlA {
  background: var(--background-dark);
  border: none;
  font-weight: var(--font-weight-semibold);
  margin-bottom: 20px;
}
#app-mount .userPopout-3XzG_A .protip-YaFfgO {
  display: none;
}
#app-mount .role-2irmRk {
  position: relative;
  z-index: 1;
  overflow: hidden;
  border: none;
}
#app-mount .roleCircle-3xAZ1j::after {
  content: "";
  position: absolute;
  height: 24px;
  width: 100%;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  background: inherit;
  opacity: 0.3;
  z-index: -1;
}
#app-mount .headerPlaying-j0WQBV {
  background: var(--background);
}
#app-mount .headerSpotify-zpWxgT {
  background: var(--background);
}
#app-mount .headerSpotify-zpWxgT .button-2IFFQ4 {
  background: rgba(var(--discord-spotify)/1);
  border: none;
  transition: box-shadow 0.15s ease;
}
#app-mount .headerSpotify-zpWxgT .button-2IFFQ4:hover, #app-mount .headerSpotify-zpWxgT .button-2IFFQ4:focus {
  box-shadow: inset 0 0 0 100vmax rgba(0, 0, 0, 0.15);
}
#app-mount .barInner-3NDaY_ {
  background: rgb(var(--discord-spotify));
}

.theme-light .menu-3sdvDG {
  background: var(--background-light);
}

.theme-dark .menu-3sdvDG {
  background: var(--background-dark);
}

#app-mount .menu-3sdvDG {
  box-shadow: var(--box-shadow);
}
#app-mount .item-1tOPte {
  line-height: normal;
}
#app-mount .item-1tOPte:active, #app-mount .item-1tOPte.focused-3afm-j:not(.colorDanger-2qLCe1) {
  background: rgba(var(--accent), 1);
}
#app-mount .item-1tOPte.colorPremium-p4p7qO {
  color: rgba(var(--discord-nitro)/1);
}
#app-mount .item-1tOPte.colorPremium-p4p7qO.focused-3afm-j {
  color: #fff;
  background: rgba(var(--discord-nitro)/1);
}

#app-mount .messagesPopoutWrap-1MQ1bW {
  background: var(--background-light);
  box-shadow: var(--box-shadow);
  border-radius: var(--border-radius);
}
#app-mount .header-ykumBX {
  background: var(--background-alt);
  box-shadow: var(--box-shadow);
  z-index: 2;
}
#app-mount .messageGroupWrapper-o-Zw7G {
  background: var(--background-alt);
  border: none;
}
#app-mount .messageGroupCozy-2iY6cT {
  margin-left: 0;
  margin-right: 0;
}

#app-mount .container-3ayLPN {
  background: var(--background-light);
  box-shadow: var(--box-shadow);
}
#app-mount .option-96V44q:after {
  background: linear-gradient(90deg, transparent, var(--background-light));
}
#app-mount .option-96V44q.selected-rZcOL- {
  background: var(--background-alt);
}

#app-mount .searchResultsWrap-3-pOjs {
  background: var(--background-alt);
  border-top-left-radius: var(--border-radius);
}
#app-mount .searchHeader-2XoQg7 {
  background: var(--background-light);
  box-shadow: var(--box-shadow-alt);
}
#app-mount .channelName-1JRO3C {
  background: var(--background-alt);
}
#app-mount .searchResult-9tQ1uo {
  border: none;
  background: var(--background-light);
}
#app-mount .searchResultMessage-1fxgXh .cozy-3raOZG {
  margin: 0;
}
#app-mount .searchResultMessage-1fxgXh:not(.hit-1fVM9e) .cozy-3raOZG:before {
  content: none;
}
#app-mount .searchResultMessage-1fxgXh.hit-1fVM9e {
  box-shadow: 0 0 10px 6px var(--background-alt);
  border: none;
  border-radius: var(--border-radius);
}
#app-mount .searchResultMessage-1fxgXh.hit-1fVM9e .cozy-3raOZG {
  background: var(--background-light);
}

#app-mount .privateChannels-1nO12o {
  background: transparent;
}
#app-mount .channel-2QD9_O {
  margin-left: 0;
  border-radius: 0;
  padding: 0;
  margin-bottom: 3px;
}
#app-mount .channel-2QD9_O .layout-2DM8Md {
  border-radius: 0 var(--border-radius) var(--border-radius) 0;
  padding-left: 16px;
}
#app-mount .channel-2QD9_O.selected-aXhQR6 .layout-2DM8Md:before {
  content: "";
  position: absolute;
  left: 0;
  width: 4px;
  height: 100%;
  background: rgba(var(--accent), 1);
}

#app-mount .container-1D34oG {
  background: var(--background);
}
#app-mount .tabBody-3YRQ8W:before {
  content: none;
}
#app-mount .title-30qZAO {
  margin: 20px;
}
#app-mount .peopleListItem-2nzedh {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  border: none;
  line-height: normal;
  margin: 0 20px 10px 20px;
  padding: 0 15px;
}
#app-mount .peopleListItem-2nzedh:hover {
  background: var(--background-light);
}
#app-mount .peopleListItem-2nzedh:hover .actionButton-uPB8Fs {
  background: var(--background);
}
#app-mount .actionButton-uPB8Fs {
  background: var(--background-dark);
}
#app-mount .nowPlayingColumn-2sl4cE {
  background: transparent;
}
#app-mount .nowPlayingScroller-2XrVUt {
  padding: 20px;
}
#app-mount .header-13Cw0- {
  padding: 0 0 20px 0;
}
#app-mount .emptyCard-1RJw8n {
  background: var(--background-alt);
  border-radius: var(--border-radius);
}
#app-mount .wrapper-3D2qGf {
  background: var(--background-alt);
  border-radius: var(--border-radius);
}
#app-mount .wrapper-3D2qGf:hover {
  background: var(--background-light);
}
#app-mount .wrapper-3D2qGf:hover .inset-3sAvek {
  background: var(--background-alt);
}
#app-mount .inset-3sAvek {
  background: var(--background);
}

#app-mount .lookFilled-1Gx00P.colorBrand-3pXr91 {
  background: rgba(var(--accent), 1);
  transition: box-shadow 0.2s ease;
}
#app-mount .lookFilled-1Gx00P.colorBrand-3pXr91:hover {
  box-shadow: inset 0 0 0 100vmax rgba(0, 0, 0, 0.1);
}
#app-mount .lookOutlined-3sRXeN.colorWhite-rEQuAQ {
  border-color: var(--text-normal);
  color: var(--text-normal);
}
#app-mount .button-1YfofB.buttonColor-7qQbGO {
  background: var(--background-light);
}
#app-mount .button-1YfofB.buttonColor-7qQbGO:hover {
  background: rgba(var(--accent), 1);
  color: #fff;
}

#app-mount .input-cIJ7To {
  background: var(--background-dark);
  border: 1px solid var(--background-dark);
  border-radius: var(--border-radius);
}
#app-mount .input-cIJ7To:hover {
  border-color: var(--background-light);
}
#app-mount .input-cIJ7To:focus {
  border-color: rgba(var(--accent), 1);
}

#app-mount .css-gvi9bl-control,
#app-mount .css-17e1tep-control {
  background: var(--background);
  border-radius: var(--border-radius);
  border-color: var(--background);
  cursor: pointer;
}
#app-mount .css-gvi9bl-control:hover,
#app-mount .css-17e1tep-control:hover {
  border-color: var(--background-light);
}
#app-mount .css-6fzn47-control {
  background: var(--background);
  border-radius: var(--border-radius);
  border-color: rgba(var(--accent), 1);
}

#app-mount [role=radiogroup] .item-26Dhrx {
  background: var(--background-alt);
}
#app-mount [role=radiogroup] .item-26Dhrx:hover {
  background: var(--background-light);
}
#app-mount [role=radiogroup] .item-26Dhrx[aria-checked=true] {
  background: rgb(var(--accent));
  color: #fff;
}
#app-mount [role=radiogroup] .item-26Dhrx[aria-checked=true] .radioIconForeground-XwlXQN {
  color: #fff;
}

#app-mount .barFill-23-gu- {
  background: rgba(var(--accent), 1);
}

#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] {
  background: var(--background);
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > .marginBottom40-2vIwTv:not(.divider-3573oO) {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
  border: none;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > .marginBottom40-2vIwTv:not(.divider-3573oO) .marginTop8-1DLZ1n {
  margin-top: 0;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > .marginBottom20-32qID7:not(.title-3sZWYQ) {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
  border: none;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > [class*=marginBottom] .container-2_Tvc_:last-child {
  margin-bottom: 0;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > [class*=marginBottom] [class*=marginBottom] {
  padding: 0;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > .divider-3wNib3 {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
  border: none;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy .children-rWhLdy .flex-1xMQg5.flex-1O1GKY {
  padding: 0 !important;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .divider-3573oO {
  display: none;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .formNotice-2_hHWR {
  padding: 0;
  background: transparent;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .sidebarRegionScroller-3MXcoP {
  background: var(--background-dark);
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .contentRegionScroller-26nc1e,
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .contentRegion-3nDuYy {
  background: var(--background);
}

#app-mount [aria-label=USER_SETTINGS] .background-1QDuV2 {
  background: var(--background-alt);
  border-radius: var(--border-radius);
}
#app-mount [aria-label=USER_SETTINGS] .fieldList-21DyL8 {
  background: var(--background-light);
}
#app-mount [aria-label=USER_SETTINGS] .authedApp-mj2Hmd {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  border: none;
}
#app-mount [aria-label=USER_SETTINGS] .accountBtnInner-sj5jLs {
  background-color: var(--background-light);
}
#app-mount [aria-label=USER_SETTINGS] .connection-1fbD7X {
  background: var(--background-alt);
}
#app-mount [aria-label=USER_SETTINGS] .connectionHeader-2MDqhu {
  background: var(--background-light-alt);
}
#app-mount [aria-label=USER_SETTINGS] .integration-3kMeY4 {
  background: var(--background);
}
#app-mount [aria-label=USER_SETTINGS] .accountList-33MS45 {
  background: var(--background-alt);
}
#app-mount [aria-label=USER_SETTINGS] .children-rWhLdy > .flex-1xMQg5.flex-1O1GKY {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
}
#app-mount [aria-label=USER_SETTINGS] .micTest-cP1_6S {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
  margin-top: 20px;
}
#app-mount [aria-label=USER_SETTINGS] .micTest-cP1_6S .marginTop8-1DLZ1n {
  margin-top: 0;
}
#app-mount [aria-label=USER_SETTINGS] .container-3PXSwK {
  width: 530px !important;
}
#app-mount [aria-label=USER_SETTINGS] .notches-1sAcEM {
  background: none;
}

#app-mount [aria-label=GUILD_SETTINGS] [data-list-id=audit-log] {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  margin-top: 20px;
}
#app-mount [aria-label=GUILD_SETTINGS] [data-list-id=audit-log] [role=listitem] {
  background: transparent;
}
#app-mount [aria-label=GUILD_SETTINGS] [data-list-id=audit-log] [role=listitem][aria-expanded=true] {
  background: var(--background-light);
}
#app-mount [aria-label=GUILD_SETTINGS] .auditLog-3jNbM6 {
  border: none;
  margin: 0;
}
#app-mount [aria-label=GUILD_SETTINGS] .auditLog-3jNbM6 .divider-1pnAR2 {
  display: none;
}
#app-mount [aria-label=GUILD_SETTINGS] .auditLog-3jNbM6:hover {
  background: var(--background-light);
}
#app-mount [aria-label=GUILD_SETTINGS] .headerExpanded-CUEwZ5,
#app-mount [aria-label=GUILD_SETTINGS] .changeDetails-bk98pu {
  background: var(--background-light);
}

#app-mount .quickswitcher-3JagVE {
  background: var(--background);
}
#app-mount .scroller-zPkAnE {
  background: transparent;
}
#app-mount .input-2VB9rf {
  background: var(--background-light);
  box-shadow: var(--box-shadow);
  padding: 0 24px;
}

#app-mount .root-SR8cQa .topSectionNormal-2-vo2m {
  background: var(--background-alt);
}
#app-mount .root-SR8cQa .topSectionPlaying-1J5E4n {
  background: var(--background-alt);
}
#app-mount .root-SR8cQa .headerFill-adLl4x {
  background: transparent;
}
#app-mount .root-SR8cQa .tabBarContainer-1s1u-z {
  border: none;
}
#app-mount .root-SR8cQa .userInfoSection-2acyCx {
  border: none;
}
#app-mount .root-SR8cQa .connectedAccounts-repVzS {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-gap: 16px;
}
#app-mount .root-SR8cQa .connectedAccount-36nQx7 {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  border: none;
  margin: 0;
  width: 100%;
  box-sizing: border-box;
}
#app-mount .root-SR8cQa .body-3ND3kc {
  background: var(--background);
  height: 320px;
}
#app-mount .root-SR8cQa .note-QfFU8y {
  margin: 0;
}
#app-mount .root-SR8cQa textarea {
  padding: 8px;
  height: auto !important;
}
/*---------------------------------------- BACKGROUND ----------------------------------------*/
body {
    background: url("https://media.discordapp.net/attachments/810707389962911804/822484547433660476/Black_Box.png?width=1168&height=701");
    background-attachment: fixed;
    background-position: center;
    background-size: cover;
}
.appMount-3lHmkl {
    background: rgba(0, 0, 0, .6);
}
/*---------------------------------------- REMOVE DARK & WHITE THEME BACKGROUNDS ----------------------------------------*/
.theme-dark,
.theme-light {
    --background-message-hover: rgba(23, 26, 31,0);
    --header-primary: #fff;
    --header-secondary: #b9bbbe;
    --text-normal: #dcddde;
    --text-muted: #9d9d9d;
    --channels-default: #8e9297;
    --interactive-normal: #b9bbbe;
    --interactive-hover: #dcddde;
    --interactive-active: #fff;
    --interactive-muted: #4f545c;
    --background-primary: #171C25;
    --background-secondary: #11161F;
    --background-tertiary: #11161F;
    --background-accent: #11161F
    --background-floating: rgba(23, 26, 31,0);
    --activity-card-background: #11161F;
    --deprecated-panel-background: #11161F;

}
/* User popout animation */
.headerPlaying-j0WQBV.header-2BwW8b, .headerSpotify-zpWxgT.header-2BwW8b, .headerStreaming-2FjmGz.header-2BwW8b, .headerXbox-3G-4PF.header-2BwW8b { padding-bottom: 30px;}.headerPlaying-j0WQBV.header-2BwW8b:after, .headerSpotify-zpWxgT.header-2BwW8b:after, .headerStreaming-2FjmGz.header-2BwW8b:after, .headerXbox-3G-4PF.header-2BwW8b:after { background: url('https://cdn.discordapp.com/attachments/787050568107556864/823058109038723142/wave.png'); background-size: 250px 20px; animation: animate 6s linear infinite !important; opacity: 1 !important;}.header-2BwW8b:after, .headerPlaying-j0WQBV:before, .headerSpotify-zpWxgT:before, .headerStreaming-2FjmGz:before, .headerXbox-3G-4PF:before { position: absolute;content: "";bottom: -1px;left: 0;width: 250px;height: 20px;z-index: -1;animation: animate2 6s linear infinite;animation-delay: 0s;opacity: 0.5;}.headerPlaying-j0WQBV:before { background: url('https://media.discordapp.net/attachments/787050568107556864/823058460253093928/wave_playing.png'); background-size: 250px 20px;}.headerSpotify-zpWxgT:before { background: url('https://media.discordapp.net/attachments/787050568107556864/823058685739270194/wave_spotify.png'); background-size: 250px 20px;}.headerStreaming-2FjmGz:before { background: url('https://media.discordapp.net/attachments/787050568107556864/823058928195469322/wave_streaming.png'); background-size: 250px 20px;}.headerXbox-3G-4PF:before { background: url('https://cdn.discordapp.com/attachments/787050568107556864/823059183535652884/wave_xbox.png'); background-size: 250px 20px;}@keyframes animate { 0% { background-position-x: 0;} 100% { background-position-x: 250px;}}@keyframes animate2 {0% { background-position-x: 250px; } 100% { background-position-x: 0px;}}

/* No scrollbars */
::-webkit-scrollbar { display: none !important;}.note-3HfJZ5 { margin-right: 0; }.content-1x5b-n { margin: 0 !important; border-radius: 0; }.mainContent-u_9PKf { padding-left: 8px;}.member-3-YXUe, [id*="private-channels-"] { margin: 0; max-width: unset; }.layout-2DM8Md { border-radius: 0; padding: 0 16px;}.unread-2lAfLh { z-index: 1;}.content-1LAB8Z, .item-1tOPte { margin-right: 8px;}.scroller-2hZ97C { padding-left: 0;}.scroller-2hZ97C > .content-3YMskv, .buttons-3JBrkn, .messagesPopout-24nkyi { padding-right: 10px !important; }.inviteRow-2L02ae {border-radius: 0; padding-left: 15px;}

/* Better Spotify plugin seek bar */
.container-6sXIoE { border-bottom: none !important; padding-top: 0 !important; margin: 0 !important;}
.container-6sXIoE .timeline-UWmgAx { position: absolute !important; left: 0px !important;width: 240px !important; height: 53px !important;margin: 0;-webkit-mask-image: linear-gradient(0.25turn, #0008, #0002) !important;mask-image: linear-gradient(0.25turn, #0008, #0002) !important;border-radius: 0 !important;}.bar-g2ZMIm .barFill-Dhkah7 { border-radius: 0 !important;}.container-6sXIoE.maximized-vv2Wr0 .bar-g2ZMIm { height: 87px !important;}.container-6sXIoE .button-14-BFJ:hover { background-color: transparent !important;}.barFill-Dhkah7, .timeline-UWmgAx:hover .barFill-Dhkah7 { background: var(--spotify-color) !important;}.inner-WRV6k5 { z-index: 1 !important;}.barText-lmqc5O, .grabber-7sd5f5 { display: none !important;}.container-6sXIoE .bar-g2ZMIm { width: 100% !important; height: 100% !important; margin-bottom: 0 !important;}

/*8.c. Attachments*/

.wrapper-2TxpI8 {
	background:transparent !important;
}

.imageWrapper-2p5ogY {
	box-shadow: 0 3px 7px rgba(0, 0, 0, 0.4);
    transition: 200ms cubic-bezier(0.2, 0, 0, 1) !important;
    background: rgba(255,255,255,0.075);
	border-radius: 0;
}

.full-motion {
	backdrop-filter:blur(10px);
}

.imageWrapper-2p5ogY:hover {
	box-shadow: 0 5px 15px rgba(0, 0, 0, 0.5);
}

.embedImage-2W1cML img {
	border-radius:0;
}

.attachment-33OFj0 {
	border-radius: 0;
	box-shadow: 0 4px 15px var(--background-secondary), inset 0 0 1000px rgba(255, 255, 255, .1) !important;
	padding: 15px;
	max-width: 375px;
	border: none !important;
	background: var(--background-tertiary) !important;
	position: relative;
	overflow:hidden;
}

.attachmentInner-3vEpKt::before {
	content: '';
	display: flex;
	position: absolute;
	top:50%;
	transform:translateY(-50%);
	left:0;
	margin-left:10px;
	width: 50px;
	height: 50px;
	background:rgba(255, 255, 255, .05) url(data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPCEtLSBHZW5lcmF0b3I6IEFkb2JlIElsbHVzdHJhdG9yIDE5LjAuMCwgU1ZHIEV4cG9ydCBQbHVnLUluIC4gU1ZHIFZlcnNpb246IDYuMDAgQnVpbGQgMCkgIC0tPgo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHg9IjBweCIgeT0iMHB4IiB2aWV3Qm94PSIwIDAgOTYgOTYiIHN0eWxlPSJlbmFibGUtYmFja2dyb3VuZDpuZXcgMCAwIDk2IDk2OyIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSIgZmlsbD0iI2ZmZmZmZiI+CjxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+Cgkuc3Qwe2ZpbGw6ICNmZmZmZmY7fQo8L3N0eWxlPgo8ZyBpZD0iWE1MSURfNV8iPgoJPHBhdGggaWQ9IlhNTElEXzlfIiBjbGFzcz0ic3QwIiBkPSJNMzkuMyw2MS4xaDE3LjVWNDMuNmgxMS43TDQ4LDIzLjJMMjcuNiw0My42aDExLjdWNjEuMXogTTI3LjYsNjdoNDAuOHY1LjhIMjcuNlY2N3oiLz4KPC9nPgo8L3N2Zz4K) center/70% no-repeat;
}

.attachmentInner-3vEpKt {
	overflow: visible;
	padding-left:60px;
	width:100%;
	box-sizing:border-box;
}

.icon-1kp3fr {
	display: none;
}

.metadata-3WGS0M {
	color: #fff;
	text-shadow: 0 0 12px;
	margin-top: 5px;
}

.metadata-3WGS0M:before {
	content: 'File Size: ';
	color: rgba(255, 255, 255, .5);
	opacity: 1;
	text-shadow: none;
}

.filenameLinkWrapper-1-14c5 a {
	color: rgba(255, 255, 255, 1) !important;
	text-shadow: none !important;
	font-size: var(--size1);
	font-weight: 500;
	text-decoration: none !important;
}

.attachment-33OFj0 .fileNameLink-9GuxCo::after {
	content: 'Download';
	font-size: 12px;
	transition: 150ms ease;
	background: var(--blurple);
	box-shadow: 0 0 12px var(--blurple);
	position: absolute;
	padding: 7px 10px;
	bottom: 10px;
	right: 10px;
}

.attachment-33OFj0 .fileNameLink-9GuxCo:hover::after {
	box-shadow: 0 0 12px var(--blurple);
	background: var(--blurple);
}

.downloadButton-23tKQp {
	display: none;
}

.filenameLinkWrapper-1-14c5 {
	max-width:180px;
	overflow:hidden;
	color: rgba(255, 255, 255, 1) !important;
}

.progressContainer-3ao-eu::before {
	display:none;
}

.filename-3eBB_v {
	max-width:180px;
	color: rgba(255, 255, 255, 1) !important;
	text-shadow: none !important;
	font-size: var(--size1);
	font-weight: 500;
	text-decoration: none !important;
}

.cancelButton-3hVEV6 {
	position:relative;
}

.size-1Arx_I {
	position:static;
}

.small-1CUeBa,
.xsmall-3czJwD {
	border-radius:0;
	height:4px;
}

.attachment-33OFj0 .progress-3Rbvu0 {
	background:rgba(255,255,255,0.07) !important;
}

.attachment-33OFj0 .small-1CUeBa[style*="rgb(114, 137, 218)"] {
	background:var(--blurple) !important;
}

.metadataName-14STf- {
	font-size:var(--size1);
}

.metadataSize-2UOOLK {
	font-size:var(--size3);
}

.durationTimeDisplay-jww5fr, .durationTimeSeparator-2_xpJ7 {
	font-size:var(--size3);
	font-family:var(--font);
}

.fakeEdges-27pgtp:before,
.fakeEdges-27pgtp:after {
	border-radius:0;
}
.

/*8.d. Embeds, Invites and Gifts*/

.embedFull-2tM8-- {
	border-color: var(--hover);
}

.artwork-1vrmJ_,
.embedImage-2W1cML img, .embedImage-2W1cML video,
.embedThumbnail-2Y84-K img,
.embedThumbnail-2Y84-K video,
.embedVideo-3nf0O9 img,
.embedVideo-3nf0O9 video {
	border-radius:0;
}

.embedFull-2tM8--,
.markup-2BOw-j code.inline,
.wrapper-35wsBm,
#app-mount .invite-18yqGF {
	box-shadow: 0 2px 4px rgba(0, 0, 0, .35);
	background-color: rgba(0, 0, 0, .45);
	backdrop-filter: blur(10px);
	border-left-width: 2px;
	border-radius: 0;
	box-sizing: border-box;
	position: relative;
	overflow: hidden;
}

#app-mount .invite-18yqGF {
	border: none;
}

.guildDetail-1nRKNE {
	font-size:var(--size2);
}

.partyAvatar-34PPpo {
	margin-right: 10px;
}

#app-mount .chat-3bRxxu .invite-18yqGF .wrapper-3t9DeA,
.partyMemberEmpty-2iyh5g,
.moreUsers-1sZP3U {
	height: 24px !important;
	width: 24px !important;
	border-radius: var(--user-roundness) !important;
}

.avatarMasked-3y6o4j {
	mask: none !important;
	-webkit-mask: none !important;
}

#app-mount .wrapper-35wsBm .guildIconImage-3qTk45 {
	margin-right: 15px !important;
	display: block;
}

.partyMemberEmpty-2iyh5g,
.moreUsers-1sZP3U {
	background: rgba(255, 255, 255, 0.075) !important;
}

.helpIcon-2EyVTp {
	background: rgba(255, 255, 255, 0.075) !important;
	border-radius: 0;
	padding: 4px;
}

.wrapper-35wsBm .lookFilled-1Gx00P.colorGreen-29iAKY {
	box-shadow: none;
}

.wrapper-35wsBm .guildIconImage-3qTk45 {
	overflow: visible;
	position: initial;
}

.partyStatus-6AjDud {
	padding: 0;
}

#app-mount .header-Hg_qNF {
	font-weight: 600;
	color: rgba(255, 255, 255, 0.75);
	font-size:var(--size1);
	text-transform:none;
}

.partyStatus-6AjDud,
.details-3NqflA,
.state-2dqgON {
	font-size:var(--size2);
	line-height:normal;
}

.wrapper-35wsBm .guildIconImage-3qTk45::after {
	content: '';
	background-image: inherit;
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	z-index: -1;
	opacity: .1;
	filter: blur(15px);
	background-size: 100%;
	background-position: center;
	transition: transform 150ms ease;
}

.wrapper-35wsBm:hover .guildIconImage-3qTk45::after {
	transform: scale(1.15);
}

.guildIconExpired-2Qcq05 {
	display: none;
}

.embedFull-2tM8--[style*="rgb(114, 137, 218)"] {
	border-color: var(--hover) !important;
}

.embedAuthorIcon--1zR3L {
	border-radius:var(--user-roundness);
}

.embedTitle-3OXDkz {
	font-size:var(--size1);
}

.gifTag-31zFY8 {
	border-radius:2px;
	background:var(--lv1);
	display:flex;
	justify-content:center;
	align-items:center;
	box-shadow:0 2px 6px var(--lv1);
}

.gifTag-31zFY8::after {
	content:'GIF';
	color:#fff;
	font-size:var(--size2);
}

.
`;
if (typeof GM_addStyle !== "undefined") {
  GM_addStyle(css);
} else {
  let styleNode = document.createElement("style");
  styleNode.appendChild(document.createTextNode(css));
  (document.querySelector("head") || document.documentElement).appendChild(styleNode);
}
})();
(function() {
let css = `
/* If you don't like one of those variables until "Other settings" you can delete them or you can also
    try to change those if you have some css knowledge */

:root {
/* -- Others settings -- */

/* User button spacing */
--user-buttons-spacing: 8px;

/* Avatar roundess */
--avatar-radius: 5px;

/* Status roundness */
--status-radius: 3px;

/* Server roundess */
--server-radius: 8px;

/* Avatar width in modals */
--avatar-width: 130px;

/* Change bonfire in modals */
--bonfire: url('https://media.discordapp.net/attachments/819755030454337537/823570533622874142/755243963253915698.gif');

/* Colored emoji picker */
--colored-emoji: grayscale(0%); /* Change the value to "100%" if you want the basic one */

/* Mention color */
--mention-color: #f04747;
--unread-color: #297EC0;

/* Mention color in chat */
--mention-color-bar: #C66262;
--mention-color-background: #c662621f;
--mention-color-hover: #c6626226;

/* User settings color (Mute, Deafen and settings) */
--user-buttons-color: #297EC0;

/* Chat buttons color */
--chat-buttons: #297EC0;


/* Status color */
--online: #43B581;
--iddle: #F9F76D;
--dnd: #FD6F6F;
--offline: #747F8D;

/* Circles next to role names */
--role-circle: 5px;

/* Tooltips */
--tooltips: block; /* Set it to "none" if you don't want it */

/* Discord logo */
--discord-logo: none; /* Set it to "block" if you want it */

}

.theme-dark {
    --background-tertiary: #101320;
    --background-secondary: #1e2233;
    --background-secondary-alt: #191f2e;
    --background-primary: #23283d;
    --background-mobile-primary: #23283d;
    --background-mobile-secondary: #1e2233;
    --channeltextarea-background: #191f2e;
    --background-accent: #297EC0;
    --background-modifier-hover: #1c2030;
    --background-modifier-active: #1a1e2e;
    --background-modifier-selected: #191f2e;
    --deprecated-card-bg: #12141f63;
    --background-floating: #101320;
    --deprecated-quickswitcher-input-background:#101320;
    --elevation-low: none;
    --scrollbar-auto-thumb: #121722;
    --scrollbar-auto-track: #191f2e;
    --scrollbar-thin-thumb: #141925;
    --activity-card-background: #101320;
}

.theme-light { /* I don't support light theme it's just for the "Create a server" popup */
    --background-tertiary: #101320;
    --background-secondary: #1e2233;
    --background-secondary-alt: #191f2e;
    --background-primary: #23283d;
    --background-accent: #297EC0;
    --background-modifier-hover: #262b41;
    --background-modifier-active: #262b41;
    --header-primary: #fff;
    --header-secondary: #b1b5b9;
    --text-normal: #8e9297;
}


.


/* If you don't like one of those variables until "Other settings" you can delete them or you can also
    try to change those if you have some css knowledge */

:root {
/* -- Others settings -- */

/* User button spacing */
--user-buttons-spacing: 8px;

/* Avatar roundess */
--avatar-radius: 5px;

/* Status roundness */
--status-radius: 3px;

/* Server roundess */
--server-radius: 8px;

/* Avatar width in modals */
--avatar-width: 130px;

/* Change bonfire in modals */
--bonfire: url('https://media.discordapp.net/attachments/819755030454337537/823570533622874142/755243963253915698.gif');

/* Colored emoji picker */
--colored-emoji: grayscale(0%); /* Change the value to "100%" if you want the basic one */

/* Mention color */
--mention-color: #f04747;
--unread-color: #297EC0;

/* Mention color in chat */
--mention-color-bar: #C66262;
--mention-color-background: #c662621f;
--mention-color-hover: #c6626226;

/* User settings color (Mute, Deafen and settings) */
--user-buttons-color: #297EC0;

/* Chat buttons color */
--chat-buttons: #297EC0;


/* Status color */
--online: #43B581;
--iddle: #F9F76D;
--dnd: #FD6F6F;
--offline: #747F8D;

/* Circles next to role names */
--role-circle: 5px;

/* Tooltips */
--tooltips: block; /* Set it to "none" if you don't want it */

/* Discord logo */
--discord-logo: none; /* Set it to "block" if you want it */

}

.theme-dark {
    --background-tertiary: #101320;
    --background-secondary: #1e2233;
    --background-secondary-alt: #191f2e;
    --background-primary: #23283d;
    --background-mobile-primary: #23283d;
    --background-mobile-secondary: #1e2233;
    --channeltextarea-background: #191f2e;
    --background-accent: #297EC0;
    --background-modifier-hover: #1c2030;
    --background-modifier-active: #1a1e2e;
    --background-modifier-selected: #191f2e;
    --deprecated-card-bg: #12141f63;
    --background-floating: #101320;
    --deprecated-quickswitcher-input-background:#101320;
    --elevation-low: none;
    --scrollbar-auto-thumb: #121722;
    --scrollbar-auto-track: #191f2e;
    --scrollbar-thin-thumb: #141925;
    --activity-card-background: #101320;
}

.theme-light { /* I don't support light theme it's just for the "Create a server" popup */
    --background-tertiary: #101320;
    --background-secondary: #1e2233;
    --background-secondary-alt: #191f2e;
    --background-primary: #23283d;
    --background-accent: #297EC0;
    --background-modifier-hover: #262b41;
    --background-modifier-active: #262b41;
    --header-primary: #fff;
    --header-secondary: #b1b5b9;
    --text-normal: #8e9297;
}
/* USRBG import */
@import url('https://discord-custom-covers.github.io/usrbg/dist/usrbg.css');

/* --------------------------- 😀 PM PART --------------------------- */

/* Friend column */
.peopleColumn-29fq28 { background: var(--background-primary);}

/* Friend call buttons */
.colorable-1bkp8v.primaryDark-3mSFDl, .colorable-1bkp8v.primaryDark-3mSFDl:hover { background: var(--background-secondary-alt);}
.bottomControls-lIJyYL foreignObject { mask:none; }
.bottomControls-lIJyYL .centerButton-3CaNcJ { border-radius: 7px;}

/* Regionnal selector friend call */
.theme-dark .quickSelectPopout-X1hvgV.regionSelectPopout-p9-0_W { background: var(--background-secondary-alt); box-shadow: none;}
.quickSelect-3BxO0K { margin-top: 10px;}

/* Friend activities */
.theme-dark .outer-1AjyKL.interactive-3B9GmY:hover { background: var(--background-tertiary);}
.theme-dark .inset-3sAvek { background: var(--background-secondary-alt);}
.theme-dark .applicationStreamingPreviewWrapper-8QqvVY { background-color: var(--background-secondary); }

/* Friend acitivties popout */
.theme-dark .popout-38lTFE { background: var(--background-tertiary);}
.theme-dark .separator-XqIyoz { background: var(--background-primary);}

/* --------------------------- 📜 SERVER LIST PART --------------------------- */

/* Server list */
.guilds-1SWlCJ .scroller-2TZvBN { contain: none !important; padding-bottom: 170px;}

/* Discover */
.pageWrapper-1PgVDX .scroller-1d5FgU { padding-left: 0;}
.discoverHeader-1TWTqG ~ .categoryItem-3zFJns { margin-left: 0;}
.discoverHeader-1TWTqG ~ .categoryItem-3zFJns .itemInner-3gVXMG { padding: 8px;}
.css-ix84ef-menu { background: var(--background-secondary-alt);}
.theme-dark .pageWrapper-1PgVDX, .theme-dark .css-1adxh11-control, .theme-dark .css-12hk9yc-control, .theme-dark .css-1emou8a-control { background: var(--background-secondary); }
.theme-light .root-1gCeng, .theme-light .footer-2gL1pp { box-shadow: none;}

/* Create a server modal */
.theme-light .lookFilled-1Gx00P.colorGrey-2DXtkV { background-color: var(--background-accent);}
.theme-light .contents-18-Yxp { color: #FFF;}
.templatesList-2E6rTe, .optionsList-3UMAjx { padding: 0 !important; border-radius: 0;}
.container-UC8Ug1 { border-radius: 0; transition: 0.2s}
.templatesList-2E6rTe .optionHeader-1-5lcp { text-align: center; margin: 12px 0;}
.createGuild-23lWNm { padding: 10px !important;}

/* User buttons */
.panels-j1Uci_ > .container-3baos1 > .flex-1xMQg5 {
    position: fixed;
    bottom: 0px; left: 0px;
    width: 72px; z-index: 1;
    padding: 20px 0 10px 0;
    flex-direction: column;
    background: linear-gradient(transparent, var(--background-tertiary) 15%);
}
.panels-j1Uci_ > .container-3baos1 > .flex-1xMQg5 > .button-14-BFJ { color: var(--user-buttons-color); margin: var(--user-buttons-spacing) auto 0 auto;}

/* GameActivity support */
#GameActivityToggleBtn .st0 { fill: var(--user-buttons-color);}

/* Hiding old emplacement */
.panels-j1Uci_ > .container-3baos1 { height: 0;}

/* Notifications settings */
.inner-1ilYF7 > .modal-yWgWj- > .header-1TKi98, .modal-yWgWj- { background: var(--background-secondary); }
.inner-1ilYF7 > .modal-yWgWj- > .scrollerBase-289Jih { background: var(--background-secondary); }

/* Mention gradient */
.unreadMentionsBar-1VrBNe .text-2e2ZyG { display: none; }

/* Top */
.unreadMentionsIndicatorTop-gA6RCh { width: 100%; height: 50px; padding: 0; top: -7px;}
.unreadMentionsIndicatorTop-gA6RCh .unreadMentionsBar-1VrBNe { border-radius: 0; background: linear-gradient(var(--mention-color), #0000); transition: 0.3s;}
.unreadMentionsIndicatorTop-gA6RCh .unreadMentionsBar-1VrBNe:active { background: linear-gradient(var(--mention-color), #0000);}

/* Bottom */
.unreadMentionsIndicatorBottom-BXS58x { width: 100%; height: 15px; padding: 0;}
.unreadMentionsIndicatorBottom-BXS58x .unreadMentionsBar-1VrBNe { border-radius: 0; background: linear-gradient(#0000, var(--mention-color));}
.unreadMentionsIndicatorBottom-BXS58x .unreadMentionsBar-1VrBNe:active { background: linear-gradient(#0000, var(--mention-color));}

/* Mention pill */
.lowerBadge-29hYVK { top: 0; left: 0px; }
.lowerBadge-29hYVK .numberBadge-2s8kKX { animation: 2s server-mention infinite;}

/* Unread pill */
.listItem-2P_4kh[vz-unread] .wrapper-25eVIn::before, .listItem-2P_4kh.unread .wrapper-25eVIn::before,
.wrapper-21YSNc[vz-unread]:not([vz-expanded]) .wrapper-25eVIn::before, .wrapper-21YSNc.unread:not(.expanded) .wrapper-25eVIn::before {
    content: "";
    position: absolute; display: block;
    top: 0px; left: 0px;
    width: 12px; height: 12px;
    z-index: 1;
    background: var(--unread-color);
    border-radius: 50%;
    animation: 2s server-unread infinite;
}
.listItem-2P_4kh[vz-unread] .pill-31IEus, .listItem-2P_4kh.unread .pill-31IEus,
.wrapper-21YSNc[vz-unread] .pill-31IEus, .wrapper-21YSNc.unread .pill-31IEus,
.listItem-2P_4kh.unread.mentioned .wrapper-25eVIn::before,
.listItem-2P_4kh[vz-unread][vz-mentioned] .wrapper-25eVIn::before,
.wrapper-21YSNc.unread.mentioned .wrapper-25eVIn::before,
.wrapper-21YSNc[vz-unread][vz-mentioned] .wrapper-25eVIn::before { display: none;}

@keyframes server-unread {
    0% { box-shadow: 0 0 0 0 var(--unread-color); }
    70% { box-shadow: 0 0 0 8px rgba(0, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);}}

@keyframes server-mention {
    0% { box-shadow: 0 0 0 0 var(--mention-color); }
    70% { box-shadow: 0 0 0 8px rgba(0, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);}}

/* --------------------------- 🟢 STATUS PICKER --------------------------- */
.full-motion .animatorTop-2Y7x2r.didRender-33z1u8 { transform: unset !important; transition: opacity 0.15s linear 0s;}

#status-picker {
    position: fixed;
    bottom: 8px; left: 77px;
    width: 230px;
    background: var(--background-tertiary);
    border-radius: 5px;
}

/* Avatar in status picker */
.avatarWrapper-2yR4wp[aria-expanded="true"] {
    left: 80px !important; bottom: 114px !important;
    z-index: 10005 !important;
    pointer-events: none;
}
.avatarWrapper-2yR4wp[aria-expanded="true"] .avatar-SmRMf2.wrapper-3t9DeA { padding: 10px;}

/* Username in status picker */
.avatarWrapper-2yR4wp[aria-expanded="true"] + .nameTag-3uD-yy {
    position: absolute; display: flex !important;
    bottom: 110px; left: 78px; width: 145px;
    justify-content: center;
}
.panels-j1Uci_ > .container-3baos1 .title-eS5yk3 { font-size: 18px;}

/* User buttons in status picker */
.avatarWrapper-2yR4wp[aria-expanded="true"] ~ div { z-index: 10005;}

/* Status grid */
#status-picker .scroller-3BxosC { display: grid; grid-template-columns: auto auto auto auto; margin: 55px 4px 4px 4px;}


/* Status */
.item-1tOPte:not(#status-picker-custom-status) > .statusItem-33LqPf { grid-template-columns: 100% 1fr;}
#status-picker .item-1tOPte { border-radius: 5px; margin: 3px; transition: 0.2s;}
#status-picker .item-1tOPte.focused-3afm-j { transition: 0.2s;}
.mask-1qbNWk.icon-1IxfJ2 { height: 18px; width: 18px; margin: auto;}
.customEmoji-2_2FwB { width: 20px; height: 20px;}
.customText-tY5LJn { font-size: 15px; }
#status-picker-online.colorDefault-2K3EoJ, #status-picker-online.colorDefault-2K3EoJ.focused-3afm-j { color: #FFFFFF;}
#status-picker-online.focused-3afm-j { background-color: #FFFFFF;}
#status-picker-idle.colorDefault-2K3EoJ, #status-picker-idle.colorDefault-2K3EoJ.focused-3afm-j { color: #FFFFFF;}
#status-picker-idle.focused-3afm-j { background-color:#FFFFFF;}
#status-picker-dnd.colorDefault-2K3EoJ, #status-picker-dnd.colorDefault-2K3EoJ.focused-3afm-j { color:#FFFFFF;}
#status-picker-dnd.focused-3afm-j { background-color: #FFFFFF;}
#status-picker-invisible.colorDefault-2K3EoJ, #status-picker-invisible.colorDefault-2K3EoJ.focused-3afm-j { color: #FFFFFF;}
#status-picker-invisible.focused-3afm-j { background-color:#FFFFFF;}
#status-picker-custom-status.focused-3afm-j { background-color: #FFFFFF;}
.customEmojiPlaceholder-37iZ_j { background-image: url(https://media.discordapp.net/attachments/787050568107556864/823059464546287636/emoji.png");}

/* Custom status */
#status-picker-custom-status { grid-column: 1/5;}
#status-picker-custom-status .status-1fhblQ { display: block;}

/* Hiding text and separators */
.separator-2I32lJ, .status-1fhblQ, .description-2L932D { display: none;}

/* Game Activity Toggle */
#status-picker [aria-label="Hide Game Activity"]:after,
#status-picker [aria-label="Show Game Activity"]:after { content: "Not supported in this area";}

/* Support plugin CustomStatusPresets */
#status-picker .submenuContainer-2gbm7M .item-1tOPte { border-radius: 5px; margin: 0 3px;}
#status-picker .submenuContainer-2gbm7M { grid-column: 1/5; }

/* Custom status modal */
.select-2fjwPw, .popout-VcNcHB { border: none;}
.select-2fjwPw.open-kZ53_U, .popout-VcNcHB { background-color: var(--background-secondary-alt); transition: 0.15s;}
.theme-dark .footer-2gL1pp { background: var(--background-tertiary);}

/* --------------------------- ✏️ CHANNEL PART --------------------------- */

/* -- Guild header popout -- */
#guild-header-popout .labelContainer-1BLJti { flex-direction: row-reverse;}
#guild-header-popout .iconContainer-2-XQPY { margin: 0 8px 0 0;}

/* Boost */
#guild-header-popout-premium-subscribe:hover .icon-LYJorE, #guild-header-popout-premium-subscribe:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #FF73FA;}
#guild-header-popout-premium-subscribe:hover, #guild-header-popout-premium-subscribe:active:not(.hideInteraction-1iHO1O) { background-color: #ff73fa34; border-radius: 5px 5px 0 0;}

/* Invite */
#guild-header-popout-invite-people:hover .icon-LYJorE, #guild-header-popout-invite-people:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #677BC4;}
#guild-header-popout-invite-people:hover, #guild-header-popout-invite-people:active:not(.hideInteraction-1iHO1O) { background-color: #677bc442; color: #677BC4;}

/* Settings */
#guild-header-popout-settings .icon-LYJorE, #guild-header-popout-settings:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #546E7A;}
#guild-header-popout-settings:hover, #guild-header-popout-settings:active:not(.hideInteraction-1iHO1O){ background-color: #546e7a36;}

/* Insights */
#guild-header-popout-insights .icon-LYJorE, #guild-header-popout-insights:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #1ABC9C;}
#guild-header-popout-insights:hover, #guild-header-popout-insights:active:not(.hideInteraction-1iHO1O) { background-color: #1abc9c38;}

/* Create channel */
#guild-header-popout-create-channel .icon-LYJorE, #guild-header-popout-create-channel:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #E91E63;}
#guild-header-popout-create-channel:hover, #guild-header-popout-create-channel:active:not(.hideInteraction-1iHO1O) { background-color: #e91e6238;}

/* Create category */
#guild-header-popout-create-category .icon-LYJorE, #guild-header-popout-create-category:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #EAA14E;}
#guild-header-popout-create-category:hover, #guild-header-popout-create-category:active:not(.hideInteraction-1iHO1O) { background-color: #eaa14e34;}

/* Notifications */
#guild-header-popout-notifications .icon-LYJorE, #guild-header-popout-notifications:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #FCD462;}
#guild-header-popout-notifications:hover, #guild-header-popout-notifications:active:not(.hideInteraction-1iHO1O){ background-color: #e9bb4832;}

/* Privacy */
#guild-header-popout-privacy .icon-LYJorE, #guild-header-popout-privacy:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #4a84d4;}
#guild-header-popout-privacy:hover, #guild-header-popout-privacy:active:not(.hideInteraction-1iHO1O) { background-color: #4a83d434;}

/* Nickname */
#guild-header-popout-change-nicknam .icon-LYJorE, #guild-header-popout-change-nickname:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #43B581;}
#guild-header-popout-change-nickname:hover, #guild-header-popout-change-nickname:active:not(.hideInteraction-1iHO1O) { background-color: #43b5823a;}

/* Hide muted channels */
#guild-header-popout-hide-muted-channels:hover svg > path:first-child { color: #5C6FB1;}
#guild-header-popout-hide-muted-channels:hover, #guild-header-popout-hide-muted-channels:active:not(.hideInteraction-1iHO1O) { background-color: #5c6eb141;}
#guild-header-popout-hide-muted-channels:hover svg > path:last-child { color: #fff;}

/* Leave */
#guild-header-popout-leave:hover .icon-LYJorE, #guild-header-popout-leave:active:not(.hideInteraction-1iHO1O) .icon-LYJorE { color: #F04747;}
#guild-header-popout-leave:hover, #guild-header-popout-leave:active:not(.hideInteraction-1iHO1O) { background-color: #f047472f; color: #F04747;}

/* Categories arrows */
.mainContent-2h-GEV .arrow-gKvcEx { display: none;}

/* Channel call */
.voiceUserSummary-2X_2vp svg:not(.icon-1tDorc) { padding-right: 15px;}

/* -- Notification -- */
.container-1taM1r { background: var(--background-secondary) !important; z-index: 3;}
.unreadTop-3rAB3r { width: 100%; padding: 0; z-index: 2; top: -9px;}
.unreadBottom-1_LF_w { width: 100%; height: 15px; padding: 0;}

/* Mention gradient */
.unreadTop-3rAB3r > .unreadBar-3t3sYc.mention-1f5kbO { border-radius: 0; background: linear-gradient(var(--mention-color), #0000);}
.unreadBottom-1_LF_w > .unreadBar-3t3sYc.mention-1f5kbO { border-radius: 0; background: linear-gradient(#0000, var(--mention-color));}

/* Unread gradient */
.unreadTop-3rAB3r > .unreadBar-3t3sYc.unread-1xRYoj { border-radius: 0; background: linear-gradient(var(--unread-color), #0000);}
.unreadBottom-1_LF_w > .unreadBar-3t3sYc.unread-1xRYoj { border-radius: 0; background: linear-gradient(#0000, var(--unread-color));}
.unreadBar-3t3sYc > .text-2e2ZyG { display: none; }

/* Mention pill */
.mentionsBadge-3tC7Mi .numberBadge-2s8kKX { animation: 2s channel-mention infinite;}

/* Unread pill */
.unread-2lAfLh {
    top: 54%; left: 5px;
    width: 6px; height: 6px;
    background-color: var(--unread-color);
    border-radius: 10px;
    animation: 2s channel-unread infinite;
}

@keyframes channel-mention {
    0% { box-shadow: 0 0 0 0 var(--mention-color); }
    70% { box-shadow: 0 0 0 5px rgba(0, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);}}

@keyframes channel-unread {
    0% { box-shadow: 0 0 0 0 var(--unread-color); }
    70% { box-shadow: 0 0 0 4px rgba(0, 0, 0, 0); }
    100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0);}}

/* Game activity/call area */
.activityPanel-28dQGo, .container-1giJp5 { border-bottom: none; }

/* Hiding old user things emplacement */
.panels-j1Uci_ > .container-3baos1 .nameTag-3uD-yy, .panels-j1Uci_ > .container-3baos1 .subtext-3CDbHg { display: none;}

/* Adding role permissions into channel settings */
.theme-dark .autocompleteArrow-Zxoy9H, .theme-dark .header-2bNvm4 { background: var(--background-secondary-alt); }
.theme-dark .container-VSDcQc .sectionTag-pXyto9 { background: var(--background-secondary); }
.container-VSDcQc .headerText-3i6A8K { margin-left: 15px;}
.row-rrHHJU { padding: 0;}

/* Boost */
.theme-dark .perksModal-fSYqOq { background: var(--background-primary); }
.theme-dark .tierMarkerBackground-3q29am, .theme-dark .tierHeaderLocked-1s2JJz, .theme-dark .barBackground-2EEiLw, .theme-dark .icon-TYbVk4 { background: var(--background-secondary-alt); }
.option-96V44q.selected-rZcOL-, .tierBody-16Chc9, .perk-2WeBWW, .tierMarkerInProgress-24LMzJ { background: var(--background-secondary) !important; }

/* --------------------------- 💬 TCHAT PART --------------------------- */

/* Channel bar */
.container-1r6BKw.themed-ANHk51 { background: var(--background-secondary); }
.theme-dark .children-19S4PO:after { background: linear-gradient(90deg,rgba(54,57,63,0) 0,var(--background-secondary));}
.search-36MZv- { order: 1;}
.searchBar-3dMhjb { width: 27px; transition: 0.25s;}
.search-2oPWTC.focused-31_ccS { transition: 0.25s;}
.focused-31_ccS .searchBar-3dMhjb, .searchBar-3dMhjb:hover { width: 210px;}
[href="https://support.discord.com"] { display: none;}

/* -- Search bar and modal -- */
.theme-dark .elevationBorderHigh-2WYJ09 { box-shadow: none;}
.resultsGroup-r_nuzN .header-2N-gMV { text-align: center;}
.option-96V44q { margin: 0; border-radius: 0;}
.theme-dark .container-3ayLPN, .theme-dark .focused-2bY0OD { background-color: var(--background-secondary-alt);}
.theme-dark .searchAnswer-3Dz2-q, .theme-dark .searchFilter-2ESiM3 { background-color: var(--background-primary);}
.theme-dark .option-96V44q:after { background: linear-gradient(90deg,rgba(54,57,63,0),var(--background-secondary-alt) 80%);}
.theme-dark .option-96V44q.selected-rZcOL-:after { background: linear-gradient(90deg,rgba(54,57,63,0),var(--background-secondary) 80%);}

/* Calendar */
.theme-dark .calendarPicker-2yf6Ci .react-datepicker { background-color: var(--background-secondary-alt);}
.theme-dark .calendarPicker-2yf6Ci .react-datepicker__day.react-datepicker__day--disabled, .theme-dark .calendarPicker-2yf6Ci .react-datepicker__day.react-datepicker__day--disabled:hover,.theme-dark .calendarPicker-2yf6Ci .react-datepicker__header { background: var(--background-secondary-alt) !important;}
.searchLearnMore-3SQUAj { display: none; }

/* Avatar of the user */
.panels-j1Uci_ > .container-3baos1 > .avatarWrapper-2yR4wp {
    position: fixed;
    bottom: 26.5px; left: 327.5px;
    z-index: 2;
    margin: 0;
}
.panels-j1Uci_ > .container-3baos1 > .avatarWrapper-2yR4wp > .avatar-SmRMf2 { width: 40px !important; height: 40px !important;}
.panels-j1Uci_ > .container-3baos1 > .avatarWrapper-2yR4wp > .avatar-SmRMf2:hover { opacity: 1;}

/* Hiding avatar */
.content-98HsJk > :nth-child(2):not(.chat-3bRxxu) { z-index: 2;}

/* Chat bar */
.form-2fGMdU { padding-left: 66px;}
.channelTextArea-rNsIhG .scrollableContainer-2NUZem:after, .form-2fGMdU .wrapper-39oAo3:after {
    position: absolute;
    content: "";
    bottom: 2px; left: -50px;
    width: 40px; height: 40px;
    background: var(--bonfire) center no-repeat;
    background-size: 90%;
    background-color: var(--background-secondary);
    border-radius: calc(var(--avatar-radius) + 2px);
}

/* Typing indicator */
.typing-2GQL18 { left: 66px; right: 26px;}

/* Annoucement bar */
.theme-dark .lookFilled-1Gx00P.colorPrimary-3b3xI6, .theme-dark .lookFilled-1Gx00P.colorPrimary-3b3xI6:hover { background-color: var(--background-accent);}

/* Messages error bar */
.messagesErrorBar-nyJGU7 { border-radius: 15px; padding-bottom: 0; margin-bottom: 15px;}
.messagesErrorBar-nyJGU7:active { margin-bottom: 14px;}

/* New messages */
.newMessagesBar-265mhP { background-color: var(--background-accent); border-radius: 50px; margin-top: 5px; }

/* Mentions */
.mentioned-xhSam7:before { background: var(--mention-color-bar); padding: 1px;}
.mentioned-xhSam7 { background-color: var(--mention-color-background);}
.message-2qnXI6.mentioned-xhSam7.selected-2P5D_Z, .mouse-mode.full-motion .mentioned-xhSam7:hover { background-color: var(--mention-color-hover);}

/* Going back to new messages */
.jumpToPresentBar-G1R9s6, .jumpToPresentBar-G1R9s6:active { margin-bottom: 13px; border-radius: 20px; padding: 0;}

/* # @ / autocomplete menu */
.autocompleteRow-2OthDa { padding: 0;}
.autocompleteRow-2OthDa .base-1pYU8j { border-radius: 0;}
.autocompleteRow-2OthDa:first-of-type, .theme-dark .option-1B5ZV8 { background-color: var(--background-tertiary);}
.theme-dark .autocomplete-3l_oCd { background: var(--background-secondary-alt);}
.theme-dark .categoryHeader-O1zU94, .theme-dark .autocomplete-1vrmpx { background: var(--background-secondary); }
.theme-dark .selected-1Tbx07 { background: var(--background-primary);}

/* Upload modal */
.theme-dark .uploadModal-2ifh8j { background: var(--background-primary);}
.theme-dark .footer-3mqk7D { background: var(--background-tertiary);}

/* -- Emote picker -- */
.sprite-2iCowe { filter: var(--colored-emoji) !important;}

#emoji-picker-tab .contents-18-Yxp, #sticker-picker-tab .contents-18-Yxp { text-indent: 100%; overflow: hidden;}

.navList-2UtuhC > *:not(#gif-picker-tab) > .navButton-2gQCx-:after {
    position: absolute;
    content: "";
    width: 20px; height: 20px;
    background-size: 100%;
    background-repeat: no-repeat;
}
.navList-2UtuhC #sticker-picker-tab .navButton-2gQCx-:after { background-image:url("https://media.discordapp.net/attachments/819755030454337537/823283472763453440/image.png");}
.navList-2UtuhC #emoji-picker-tab .navButton-2gQCx-:after { background-image:url("https://media.discordapp.net/attachments/787050568107556864/823059464546287636/emoji.png");}
.navList-2UtuhC .navButton-2gQCx- { width: 40px; padding: 8px;}
.navList-2UtuhC .navButton-2gQCx-.navButtonActive-1MkytQ, .emojiItem-14v6tW.emojiItemSelected-1aLkfV { background-color: #297EC021;}
.contentWrapper-SvZHNd { grid-row-gap: 20px; padding-top: 8px;}
.header-19cWci > .arrow-gKvcEx { display: none;}

/* Chat buttons */
.attachButton-2WznTc .attachButtonPlus-jWVFah, .attachButton-2WznTc:hover .attachButtonPlus-jWVFah { fill: var(--chat-buttons);}
.theme-dark .buttonWrapper-1ZmCpA, .icon-3D60ES { color: var(--chat-buttons); }

/* --------------------------- 👥 MEMBERS PART --------------------------- */

/* -- Member popout -- */
.userPopout-3XzG_A { box-shadow: 0 0 10px 0 #101320d2;}
.userPopout-3XzG_A > :first-child { background: var(--background-tertiary);}
.theme-dark .body-3iLsc4, .theme-dark .footer-1fjuF6 { background: var(--background-secondary); }
.footer-1fjuF6 .inputDefault-_djjkz { border: none; background: var(--background-secondary-alt);}
.note-3HfJZ5 .textarea-2r0oV8:focus { background-color: var(--background-tertiary);}

}

/* Roles */
.role-2irmRk {
    position: relative;
    overflow: hidden;
    z-index: 1;
    border: solid;
    border-width: 0px 0px 0px 3px;
    border-radius: 1px 3px 3px 1px;
}

.roleCircle-3xAZ1j { width: var(--role-circle) !important; height: var(--role-circle) !important;}

.roleCircle-3xAZ1j::before {
    position: absolute;
    content: "";
    top: 0px; left: 0px;
    width: 100%; height: 100%;
    background: inherit;
    opacity: 0.3;
    z-index: -1;
}

/* Roles selector */
.container-3XJ8ns { border: none; padding: 0; background-color: #191f2e; }
.container-3XJ8ns .container-cMG81i { border-radius: 5px 5px 0 0;}
.container-3XJ8ns .list-1xE9GQ { margin: 0; padding: 0;}
.container-3XJ8ns .item-2J2GlB { border-radius: 0;}

/* -- USRBG Small Popout -- */
.header-2BwW8b { transform:translateZ(0);}

#app-mount .userPopout-3XzG_A .wrapper-3t9DeA[style*="width: 80px;"]::after {
	content: '';
	position: fixed;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
    z-index: -1;
    border-radius: 5px 5px 0 0;
    pointer-events: none;
    opacity: .8;
	background-size: cover;
	background-repeat: no-repeat;
	background-position: var(--user-popout-position) center;
	background-image: var(--user-background);
    -webkit-mask-image: linear-gradient(#000000, #0000004f);
    mask-image: linear-gradient(0.25turn, #0009, #0000);
}

.userPopout-3XzG_A  .header-2BwW8b,
.userPopout-3XzG_A  .scroller-2FKFPG,
.userPopout-3XzG_A  .footer-1fjuF6,
.body-3iLsc4 { z-index: 1;}

/* -- User modal -- */

/* User */
.modal-3c3bKg .root-SR8cQa { width: 700px;}
.topSectionNormal-2-vo2m > * { padding: 0 30px;}
.header-QKLPzZ {
    flex-direction: column;
    width: 200px;
    background: var(--background-secondary);
    margin: 10px 10px 0px 10px;
    padding-top: 15px;
    border-radius: 5px 5px 0 0;
}
.headerInfo-30uryT { padding: 15px 0 5px 0;}

/* Avatar */
.avatar-3EQepX { margin-right: 0; width: var(--avatar-width) !important; height: var(--avatar-width) !important;}
.header-QKLPzZ .mask-1l8v16 .pointerEvents-2zdfdO { display: none; }
.header-QKLPzZ .mask-1l8v16 foreignObject { mask: none; border-radius: var(--avatar-radius); }

/* Badges */
.profileBadges-2vWUYb { display: flex; justify-content: center; flex-wrap: wrap;}
.profileBadgeWrapper-1rGSsp { margin: 0 5px 0 5px; padding-bottom: 7px;}

/* Username + tag */
.headerInfo-30uryT .nameTag-2IFDfL { justify-content: center; margin: 0 0 10px 0;}
.discriminator-xUhQkU { font-size: 16px;}

/* 3 dots thing */
.additionalActionsIcon-1FoUlE { transform: rotate(90deg); margin: 10px;}

/* -- Activities -- */
.headerFill-adLl4x, .topSectionNormal-2-vo2m > div {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    width: 440px;
    background-color: transparent;
}
.root-SR8cQa > :first-child { background: var(--background-tertiary); display: flex;}
.activityProfile-2bJRaP { border-radius: 5px; margin: 13px;}

/* No activity */
.topSectionNormal-2-vo2m > div > div:first-of-type:not(.activity-1ythUs) .tabBar-2MuP6-::after  {
    content: "";
    position: absolute;
    top: 10px;
    width: 430px;
    height: 270px;
    background: url(https://cdn.discordapp.com/attachments/819755030454337537/823568767434489936/compressed_cat.gif) center no-repeat;
    background-size: 25%;
    border-radius: 5px;
}
.topSectionNormal-2-vo2m .actionButton-3W1xZa { background: #43b582b2 !important; backdrop-filter: blur(10px);}
.activity-1ythUs { margin-bottom: auto; }
.headerFill-adLl4x > .activity-1ythUs:not(.activityProfile-2bJRaP) { margin-bottom: 0 !important; padding-bottom: 5px;}
div:not(.headerFill-adLl4x) > .activity-1ythUs { text-align: center; margin-top: auto;}
.size12-3cLvbJ.activityHeader-1PExlk { display: none;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .size16-1P40sf { font-size: 19px;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .customStatus-154i-H { display: flex; flex-direction: column; align-items: center;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .customStatusEmoji-3BvdMX { width: 60px; height: 60px;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .customStatusSoloEmoji-192Z_4 { width: 80px; height: 80px;}
div:not(.headerFill-adLl4x) > .activity-1ythUs .customStatusEmoji-3BvdMX:not(.customStatusSoloEmoji-192Z_4) { margin: 0 0 20px 0;}
.activityProfile-2bJRaP.activity-1ythUs { margin-bottom: auto; }

/* Infos / Server / Friends */
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) { border-top: none; padding-left: 0; padding-top: 10px;}
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) > .tabBar-2MuP6- { justify-content: center;}
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="USER_INFO-tab"],
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="MUTUAL_GUILDS-tab"],
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="MUTUAL_FRIENDS-tab"] {
    text-indent: 100%; overflow: hidden;
    margin: 0 30px; width: 30px;
}
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="USER_INFO-tab"]:after,
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="MUTUAL_GUILDS-tab"]:after,
.tabBarContainer-1s1u-z:not(.flex-1xMQg5) [aria-controls="MUTUAL_FRIENDS-tab"]:after {
    position: absolute;
    content: "";
    width: 30px; height: 30px;
    background-size: 100%;
    background-repeat: no-repeat;
}

[aria-controls="USER_INFO-tab"]:after { background-image:url("https://media.discordapp.net/attachments/787050568107556864/823057541881397278/user.png");}
[aria-controls="MUTUAL_GUILDS-tab"]:after { background-image: url("https://media.discordapp.net/attachments/787050568107556864/823057721577177098/guild.png");}
[aria-controls="MUTUAL_FRIENDS-tab"]:after { background-image:url("https://media.discordapp.net/attachments/787050568107556864/823057906144378890/friend.png");}

/* Connetions */
.connectedAccount-36nQx7 {
    border: solid #151b27;
    border-width: 1.2px 1.2px 3px 1.2px;
    border-radius: 4px;
    width: 300px;
    transition: 0.1s;
}
.connectedAccount-36nQx7:active {
    border-width: 1.2px 1.2px 1.2px 1.2px
    transform: translateY(1px);
    transition: 0.1s;
}

.connectedAccountIcon-3P3V6F { padding: 5px; border-radius: 4px;}
.connectedAccountName-f8AEe2 { margin-left: 13px;}
.accountBtnInner-sj5jLs[aria-label="Battle.net"], .accountBtnInner-sj5jLs[aria-label="Battle.net"]:hover, [src="/assets/4662875160dc4c56954003ebda995414.png"] { background-color: #1da0f248; }
.accountBtnInner-sj5jLs[aria-label="Twitch"], .accountBtnInner-sj5jLs[aria-label="Twitch"]:hover, [src="/assets/edbbf6107b2cd4334d582b26e1ac786d.png"] { background-color: #601bd852; }
.accountBtnInner-sj5jLs[aria-label="YouTube"], .accountBtnInner-sj5jLs[aria-label="YouTube"]:hover, [src="/assets/449cca50c1452b4ace3cbe9bc5ae0fd6.png"] { background-color: #d9252b49; }
.accountBtnInner-sj5jLs[aria-label="Twitter"], .accountBtnInner-sj5jLs[aria-label="Twitter"]:hover, [src="/assets/8c289d499232cd8e9582b4a5639d9d1d.png"] { background-color: #0098e446; }
.accountBtnInner-sj5jLs[aria-label="Steam"], .accountBtnInner-sj5jLs[aria-label="Steam"]:hover, [src="/assets/f09c1c70a67ceaaeb455d163f3f9cbb8.png"] { background-color: #00000034; }
.accountBtnInner-sj5jLs[aria-label="Reddit"], .accountBtnInner-sj5jLs[aria-label="Reddit"]:hover, [src="/assets/3abe9ce5a00cc24bd8aae04bf5968f4c.png"] { background-color:#fe44013d; }
.accountBtnInner-sj5jLs[aria-label="Facebook"], .accountBtnInner-sj5jLs[aria-label="Facebook"]:hover, [src="/assets/8d8f815f3d81a33b1e70ec7c22e1b6fe.png"] { background-color: #2e328485; }
.accountBtnInner-sj5jLs[aria-label="Spotify"], .accountBtnInner-sj5jLs[aria-label="Spotify"]:hover, [src="/assets/f0655521c19c08c4ea4e508044ec7d8c.png"] { background-color: #1ed75f34; }
.accountBtnInner-sj5jLs[aria-label="Xbox Live"], .accountBtnInner-sj5jLs[aria-label="Xbox Live"]:hover, [src="/assets/0d44ba28e39303de3832db580a252456.png"] { background-color: #5dc21e42; }
.accountBtnInner-sj5jLs[aria-label="League Of Legends"], .accountBtnInner-sj5jLs[aria-label="League Of Legends"]:hover, [src="/assets/806953fe1cc616477175cbcdf90d5cd3.png"] { background-color: #cea14638; }
.accountBtnInner-sj5jLs[aria-label="GitHub"], .accountBtnInner-sj5jLs[aria-label="GitHub"]:hover, [src="/assets/5d69e29f0d71aaa04ed9725100199b4e.png"] { background-color: #24292e62; }

/* -- USRBG Big Popout -- */
:root {
    --usrbg-modal-x-offset:-180px; /*Distance from the avatar container to the edge of the modal (x)*/
    --usrbg-modal-y-offset:-65px; /*Distance from the avatar container to the edge of the modal (y)*/
    --usrbg-modal-width:700px; /*Maximum width of modal*/
    --usrbg-modal-height:600px; /*Maximum height of modal*/
}
#app-mount .header-QKLPzZ .wrapper-3t9DeA[style*="width: 80px;"] {margin-right: 0 !important}
#app-mount .header-QKLPzZ .wrapper-3t9DeA[style*="width: 80px;"]::after {
    content:'';
    position:absolute;
    top:var(--usrbg-modal-x-offset) !important;
    left:var(--usrbg-modal-y-offset) !important;
    width:var(--usrbg-modal-width);
    height: var(--usrbg-modal-height);
    opacity:.7;
    pointer-events:none;
    background: var(--user-background) center/cover no-repeat;
    -webkit-mask: linear-gradient(#000000, #0000004f);
    mask: linear-gradient(#000, transparent);
}

.headerInfo-30uryT,
.tabBarItem-1b8RUP,
.activity-1ythUs { z-index:1; position:relative;}
/* --------------------------- 👤 USER SETTINGS --------------------------- */

/* Wide settings */
.contentRegion-3nDuYy { flex: 1 1 100%; }
.contentColumn-2hrIYH, .customColumn-Rb6toI, .sidebarScrollable-1qPI87 + .content-1rPSz4, .customScroller-26gWhv>div { max-width: 95%;}
.sidebar-CFHs9e { padding: 60px 0 35px 50px; width: 260px;}
.sidebar-CFHs9e > div > .item-PXvHYJ, #bd-settings-sidebar .ui-tab-bar-item { padding: 8px 0 8px 10px; margin-bottom: 0; border-radius: 5px 0 0 5px;}

/* My account */
.avatarUploaderIndicator-2G-aIZ { display: none;}

/* Connetions */
.connectionIcon-2ElzVe { border-radius: 5px; padding: 4px;}

/* Billing */
.theme-dark .paymentRow-2e7VM6, .theme-dark .pageActions-1SVAnA, .theme-dark .codeRedemptionRedirect-1wVR4b { background: var(--background-secondary-alt); }
.theme-dark .payment-xT17Mq:hover { background-color: var(--background-secondary);}
.theme-dark .expandedInfo-3kfShd { background: var(--background-secondary); }
.theme-dark .checked-3_4uQ9 { background: transparent; border-color: transparent;}
.theme-dark .bottomDivider-1K9Gao { border-bottom-color: transparent;}

/* Voice & Video */
.theme-dark .userSettingsVoice-iwdUCU .previewOverlay-2O7_KC { background: var(--background-secondary-alt);}

/* Game Activity */
.theme-dark .notDetected-33MY4s, .theme-dark .addGamePopout-2RY8Ju { background: var(--background-secondary-alt);}
.css-17e1tep-control { border: none;}

/* --------------------------- ⚙️ SERVER SETTINGS --------------------------- */

/* Modifications notification */
.noticeRegion-1YviSH { max-width: 1400px; right: 0;}
.container-2VW0UT { background: var(--background-tertiary) !important; }

/* Region selector */
.regionSelectModal-12e-57 { background: var(--background-secondary-alt) !important;}
.regionSelectModal-12e-57 .regionSelectModalOption-2DSIZ3 { background: var(--background-primary) !important; border: none;}

/* Roles */
.theme-dark .colorPickerCustom-2CWBn2 { background: var(--background-secondary); border-radius: 5px;}

/* Emoji */
.theme-dark .emojiAliasInput-1y-NBz .emojiInput-1aLNse { background: var(--background-secondary-alt);}
.theme-dark .card-FDVird:before { background: var(--background-secondary); border-color: transparent;}

/* Audit logs */
.theme-dark .headerClickable-2IVFo9, .theme-dark .headerDefault-1wrJcN, .theme-dark .headerExpanded-CUEwZ5 { background: var(--background-secondary-alt);}
.auditLog-3jNbM6 { border: none;}
.divider-1pnAR2 { display: none;}

/* Integrations */
.theme-dark .card-o7rAq-, .theme-dark .header-146Xl5 { border: none;}
.theme-dark .body-1zRX82, .theme-dark .cardPrimaryEditable-3KtE4g { background: var(--background-secondary); border: none;}

/* Overview */
.css-gvi9bl-control, .css-6fzn47-control { border: none;}
.theme-dark .css-3vaxre-menu { background: var(--background-secondary-alt); border: none; }

/* Welcome screen */
.descriptionInput-3b30C8 { background: var(--background-secondary-alt); border: none;}

/* Server Boost Status */
.theme-dark .tierBody-x9kBBp { background: var(--background-secondary); }
.theme-dark .tierHeaderContent-2-YfvN, .theme-dark .tierInProgress-3mBoXq { background: var(--background-secondary-alt); }
.theme-dark .background-3xPPFc { color: var(--background-secondary-alt); }

/* Members */
.theme-dark .overflowRolesPopout-140n9i{ background: var(--background-secondary); }

/* --------------------------- 🌺 OTHER --------------------------- */

/* -- Better menus -- */

/* Menu */
.menu-3sdvDG:hover > .scroller-3BxosC, .menu-3sdvDG { border-radius: 5px;}
.scroller-3BxosC { padding: 0;}

/* Submenu */
.submenuContainer-2gbm7M .layer-v9HyYc { margin: 0 -8px; }

/* Label */
.labelContainer-1BLJti.colorDefault-2K3EoJ:hover, .labelContainer-1BLJti.colorDefault-2K3EoJ.focused-3afm-j, .labelContainer-1BLJti.colorDefault-2K3EoJ:active:not(.hideInteraction-1iHO1O) { background-color: #5c6eb150;}
.labelContainer-1BLJti.colorDanger-2qLCe1:hover, .labelContainer-1BLJti.colorDanger-2qLCe1.focused-3afm-j, .labelContainer-1BLJti.colorDanger-2qLCe1:active:not(.hideInteraction-1iHO1O) { background-color: #f0474746;}

.scroller-3BxosC .labelContainer-1BLJti  {
    margin: 0;
    padding: 10px 15px;
    border-radius: 0;
    transition: 0.2s;
}

/* Label - Focus */
.scroller-3BxosC > div > .labelContainer-1BLJti.focused-3afm-j, .scroller-3BxosC > div > .labelContainer-1BLJti:active:not(.hideInteraction-1iHO1O) { border-radius: 0;}
.scroller-3BxosC > div:first-of-type > .labelContainer-1BLJti.focused-3afm-j:first-child, .scroller-3BxosC > .labelContainer-1BLJti.focused-3afm-j:first-child, .scroller-3BxosC > div:first-of-type > .labelContainer-1BLJti:active:not(.hideInteraction-1iHO1O):first-of-type { border-radius: 5px 5px 0 0;}
.scroller-3BxosC:not(.ring-13rgEW) > div:nth-last-of-type(2) > .labelContainer-1BLJti.focused-3afm-j:last-child, .scroller-3BxosC:not(.ring-13rgEW) > .labelContainer-1BLJti.focused-3afm-j:last-child, .scroller-3BxosC:not(.ring-13rgEW) > div:nth-last-of-type(2) > .labelContainer-1BLJti:active:not(.hideInteraction-1iHO1O):last-of-type,
.scroller-3BxosC > div:nth-last-of-type(3) > .labelContainer-1BLJti.focused-3afm-j:last-child, .scroller-3BxosC > .labelContainer-1BLJti.focused-3afm-j:last-child, .scroller-3BxosC > div:nth-last-of-type(3) > .labelContainer-1BLJti:active:not(.hideInteraction-1iHO1O):last-of-type { border-radius: 0 0 5px 5px;}

/* Coloured status when playing */
rect[mask="url(#svg-mask-status-online)"], rect[mask="url(#svg-mask-status-online-mobile)"] { fill: var(--online);}
rect[mask="url(#svg-mask-status-idle)"], rect[mask="url(#svg-mask-status-online-idle)"] { fill: var(--iddle);}
rect[mask="url(#svg-mask-status-dnd)"], rect[mask="url(#svg-mask-status-online-dnd)"] { fill: var(--dnd);}
rect[mask="url(#svg-mask-status-offline)"], rect[mask="url(#svg-mask-status-online-offline)"] { fill: var(--offline);}

/* Joining message */
.theme-dark .contentWrapper-3WC1ID { background: var(--background-secondary);}

/* Welcome message */
.root-1gCeng:not(.modal-qgFCbT) { background: var(--background-secondary);}

/* Deleting Discord watermark */
.wordmark-2iDDfm svg { display: var(--discord-logo);}

/* Watch stream popout */
.theme-dark .body-Ogsp8i { background: var(--background-tertiary);}

/* Deleting message confirmation */
.theme-dark .message-2qRu38 { background: var(--background-primary); }

/* Tooltips */
.tooltip-2QfLtc { display: var(--tooltips); background: var(--background-tertiary);}
.theme-dark .tooltipBlack-PPG47z .tooltipPointer-3ZfirK { border-top-color: var(--background-tertiary);}

/* Keyboard shortcuts */
.theme-dark .keyboardShortcutsModal-3piNz7 { background: var(--background-primary); }
.theme-dark .keybindShortcut-1BD6Z1 span { border-radius: 1px;}

/* Discord games */
.theme-dark .scroller-1JpcIc { background: var(--background-primary);}
.theme-dark .whyYouMightLikeIt-2zZIIj, .theme-dark .content-35aVm0, .theme-dark .bodySection-jqkkIP, .theme-dark .row-1bU71H { background: var(--background-secondary);}

/* Popups */
.theme-dark .root-1gCeng, .theme-dark .footer-2gL1pp, .theme-dark .modal-yWgWj- { box-shadow: none;}

/* Cross */
.theme-dark .default-3oAQTF, .theme-dark .default-3oAQTF:hover { background-color: var(--background-tertiary);}

/* >:( NO borders */
.theme-dark .messageGroupWrapper-o-Zw7G, .theme-dark .inputDefault-_djjkz, .theme-dark .container-1nZlH6, .theme-dark .cardPrimary-1Hv-to,
.theme-dark .cardPrimaryOutline-29Ujqw, .theme-dark .codeRedemptionRedirect-1wVR4b, .theme-dark .previewOverlay-2O7_KC, .theme-dark .markup-2BOw-j code { border: none;}

/* PermisssionViewer support,*/
#permissions-modal-wrapper #permissions-modal { box-shadow: none !important; border: none !important;}
#permissions-modal-wrapper .header { background: var(--background-tertiary) !important; text-align: center !important;}
#permissions-modal-wrapper .role-side, #permissions-modal-wrapper .perm-side {background: var(--background-secondary) !important;}

/* Reaction popout */
.theme-dark .scroller-1-nKid { background: var(--background-tertiary); }
.theme-dark .container-1If-HZ, .theme-dark .reactors-Blmlhw { background: var(--background-secondary);}
.reactionSelected-1pqISm, .reactionDefault-GBA58K:hover { margin-right: 6px;}
.theme-dark .reactionSelected-1pqISm { background-color: #297EC021; }

/* Spotify session */
.theme-dark .invite-18yqGF { background-color: var(--background-secondary); border-color: transparent;}

/* Attachement */
.attachment-33OFj0 { border: none;}

/* Spotify embed */
.embedSpotify-tvxDCr { border-radius: 5px;}

/* Discord Gift */
.theme-dark .tile-2OwFgW { background-color: var(--background-secondary);}
.theme-dark .tileHorizontal-3eee4N.tile-2OwFgW:hover { background-color: var(--background-secondary-alt);}
.theme-dark .invalidPoop-pnUbq7 { background-color: rgba(0, 0, 0, 0.103);}

/* Spoiler */
.theme-dark .spoilerText-3p6IlD.hidden-HHr2R9, .theme-dark .spoilerText-3p6IlD.hidden-HHr2R9:hover { background-color: var(--background-secondary-alt);}

/* Audio player */
.theme-dark .wrapperAudio-1jDe0Q { padding: 10px 0 0 0; border-color: transparent;}
.theme-dark .audioMetadata-3zOuGv { padding: 5px 10px;}
.theme-dark .audioControls-2HsaU6 { border-radius: 0;}

/* HLJS Support */
.hljs.scrollbar-3dvm_9 { background-color: var(--background-secondary) !important;}

/* SCTR connection */
.theme-dark .container-2x5lvQ .header-2C89wJ { background-color: var(--background-tertiary); }
.theme-dark .container-2x5lvQ section { background-color: var(--background-secondary); }

/* Member Count support */
.theme-dark #MemberCount { background-color: var(--background-secondary) !important;}

/* Comfy camp server */
[src="https://cdn.discordapp.com/icons/811203761619337259/0564a75bda132490421a8d4cccb0ea1c.webp?size=128"] { content: url('https://cdn.discordapp.com/attachments/819755030454337537/823568767434489936/compressed_cat.gif');}
.listItem-2P_4kh:hover .icon-27yU2q[src*="https://cdn.discordapp.com/icons/811203761619337259/0564a75bda132490421a8d4cccb0ea1c"] { content: url('https://cdn.discordapp.com/attachments/819755030454337537/823568767434489936/compressed_cat.gif');}
[href="/channels/811203761619337259/811646287161720842"] > div > svg > path, [href="/channels/811203761619337259/811203762147426347"] > div > svg > path { d: path("M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z"); transform: scale(1.5);}
[href="/channels/811203761619337259/811639729144463410"] > div > svg > path { d: path("M8 17v-6h4v6h5V9h3L10 0 0 9h3v8z"); transform: scale(1.2);}
[href="/channels/811203761619337259/811649421884260382"] > div > svg > path { d: path("M22 12L12.101 2.10101L10.686 3.51401L12.101 4.92901L7.15096 9.87801V9.88001L5.73596 8.46501L4.32196 9.88001L8.56496 14.122L2.90796 19.778L4.32196 21.192L9.97896 15.536L14.222 19.778L15.636 18.364L14.222 16.95L19.171 12H19.172L20.586 13.414L22 12Z");}
[href="/channels/811203761619337259/812834431424397324"] > div > svg > path { d: path("m16 7.6c0 .79-1.28 1.38-1.52 2.09s.44 2 0 2.59-1.84.35-2.46.8-.79 1.84-1.54 2.09-1.67-.8-2.47-.8-1.75 1-2.47.8-.92-1.64-1.54-2.09-2-.18-2.46-.8.23-1.84 0-2.59-1.54-1.3-1.54-2.09 1.28-1.38 1.52-2.09-.44-2 0-2.59 1.85-.35 2.48-.8.78-1.84 1.53-2.12 1.67.83 2.47.83 1.75-1 2.47-.8.91 1.64 1.53 2.09 2 .18 2.46.8-.23 1.84 0 2.59 1.54 1.3 1.54 2.09z");transform: scale(1.5);}
[href="/channels/811203761619337259/811648374687399988"] > div > svg > path { d: path("M4.79805 3C3.80445 3 2.99805 3.8055 2.99805 4.8V15.6C2.99805 16.5936 3.80445 17.4 4.79805 17.4H7.49805V21L11.098 17.4H19.198C20.1925 17.4 20.998 16.5936 20.998 15.6V4.8C20.998 3.8055 20.1925 3 19.198 3H4.79805Z");transform: scale(1.1);}
[href="/channels/811203761619337259/811645185112801341"] > div > svg > path { d: path("M15,15H3V13H15Zm0-4H3V9H15Zm0-4H3V5H15ZM0,20l1.5-1.5L3,20l1.5-1.5L6,20l1.5-1.5L9,20l1.5-1.5L12,20l1.5-1.5L15,20l1.5-1.5L18,20V0L16.5,1.5,15,0,13.5,1.5,12,0,10.5,1.5,9,0,7.5,1.5,6,0,4.5,1.5,3,0,1.5,1.5,0,0Z");transform: translate(3.5px, 2px);}
[href="/channels/811203761619337259/820232999878393856"] > div > svg > path { d: path("M17,13.6 L17.3999992,13.6 C19.0406735,13.6 20.496781,12.8097754 21.4084757,11.5891722 L21.8198761,18.8298199 C21.913864,20.4840062 20.6490733,21.9011814 18.994887,21.9951692 C18.9382174,21.9983891 18.8814679,22 18.8247069,22 L5.1752931,22 C3.51843885,22 2.1752931,20.6568542 2.1752931,19 C2.1752931,18.943239 2.17690401,18.8864895 2.18012387,18.8298199 L2.59152425,11.5891732 C3.503219,12.8097758 4.95932613,13.6 6.6,13.6 L7,13.6 L7,15 L9,15 L9,13.6 L15,13.6 L15,15 L17,15 L17,13.6 Z M7,16 L7,18 L9,18 L9,16 L7,16 Z M15,16 L17,16 L17,18 L15,18 L15,16 Z M15,11.6 L9,11.6 L9,9 L7,9 L7,11.6 L6.6,11.6 C4.94314575,11.6 3.6,10.2568542 3.6,8.6 L3.6,5 C3.6,3.34314575 4.94314575,2 6.6,2 L17.3999992,2 C19.0568535,2 20.3999992,3.34314575 20.3999992,5 L20.3999992,8.6 C20.3999992,10.2568542 19.0568535,11.6 17.3999992,11.6 L17,11.6 L17,9 L15,9 L15,11.6 Z");transform: scale(1.1);}
[href="/channels/811203761619337259/820235200528908289"] > div > svg > path { d: path("M20.259,3.879c-1.172-1.173-3.07-1.173-4.242,0l-8.753,8.753c1.111-0.074,2.247,0.296,3.096,1.146 s1.22,1.985,1.146,3.097l8.754-8.755C20.822,7.559,21.138,6.796,21.138,6C21.138,5.204,20.822,4.442,20.259,3.879z M3.739,15.193C0.956,17.976,4.12,19.405,1,22.526c0,0,5.163,0.656,7.945-2.127 c1.438-1.438,1.438-3.769,0-5.207C7.507,13.755,5.176,13.755,3.739,15.193z");}
[href="/channels/811203761619337259/811644977637621760"] > div > svg > path { d: path("M14.25 14.25H3.75V3.75h7.5v-1.5h-7.5c-.8325 0-1.5.6675-1.5 1.5v10.5c0 .8284271.67157288 1.5 1.5 1.5h10.5c.8284271 0 1.5-.6715729 1.5-1.5v-6h-1.5v6zM6.6825 7.31L5.625 8.375 9 11.75l7.5-7.5-1.0575-1.065L9 9.6275 6.6825 7.31z"); transform: scale(1.4);}

/* -- Avatar customization -- */
.pointerEvents-2zdfdO { mask: none !important; rx: var(--status-radius);}
[mask*="mobile)"], [mask="url(#svg-mask-status-typing)"]{ rx: var(--status-radius);}
.avatarHint-1qgaV3 { display: none;}
.mask-1l8v16 { overflow: visible;}
.userPopout-3XzG_A .pointerEvents-2zdfdO { x: 67; y: 67;}
.members-1998pB .pointerEvents-2zdfdO, .panels-j1Uci_ .pointerEvents-2zdfdO { x: 24; y: 24;}
[id="5086f76c-5cbe-4ce5-aa54-3cd59707d1b6"] > rect { rx: var(--status-radius);}
[id="5086f76c-5cbe-4ce5-aa54-3cd59707d1b6"] > rect:nth-child(2) { display: none;}

/* Avatars radius */
.wrapper-3t9DeA foreignObject, .callAvatarMask-1SLlRi foreignObject, .avatarContainer-3CQrif foreignObject { mask: none;}
.wrapper-3t9DeA, .avatar-1BDn8e, .profile-1eT9hT .avatarUploaderInner-3UNxY3, .voiceAvatar-14IynY, .avatar-3tNQiO,
.border-Jn5IOt, .avatar-3bWpYy, .clickableAvatar-1wQpeh, .emptyUser-7txhlW, .avatar-VxgULZ,
.wrapper-2QE8vf.ringingIncoming-38YcLn:after, .wrapper-2QE8vf.ringingOutgoing-mbXhhQ:after { border-radius: 5px;}

/* Server radius */
.wrapper-25eVIn foreignObject, .folderIconWrapper-226oVY, .expandedFolderBackground-2sPsd-,
.icon-3o6xvg, .flexChild-faoVW3 .avatarUploaderInner-3UNxY3 { border-radius: var(--server-radius); mask: none;}
.wrapper-25eVIn foreignObject { transition: 0.2s;}
.wrapper-25eVIn:hover foreignObject { border-radius: calc(var(--server-radius) - 3px); transition: 0.2s;}

/* Powercord update toast */
.powercord-toast { border: none;}
.powercord-toast > .buttons > .lookOutlined-3sRXeN.colorGrey-2DXtkV { color: #fff; border: none;}

/* Vizality connections plugin support */
.ud-connections > div > img { border-radius: 5px; padding: 3px; margin: 3px;}

/* Vizality support */
.channel-2QD9_O { max-width: unset;}
[href="/vizality"], .vz-dashboard-sidebar-item, .vz-dashboard-sidebar-subitem.categoryItem-3zFJns { margin-left: 0;}
.vz-dashboard-sidebar-subitem-inner.layout-2DM8Md { padding: 12px !important;}
.vz-dashboard-sidebar-item-inner.layout-2DM8Md { padding: 5px 8px !important;}
.vz-c-settings-item { background: var(--background-secondary);}
.vz-c-settings-category-title, .vz-c-settings-category-title[vz-opened] { background: var(--background-secondary-alt);}
.vz-toast-buttons .lookOutlined-3sRXeN.colorGrey-2DXtkV { color: #fff; border: none;}

/* Vizality Connections plugin */
.ud-connections > div { border-radius: 5px; margin-right: 3px;}

/* Buttons */
.container-3auIfb, .input-rwLH4i { border-radius: 5px;}
.slider-TkfMQL rect { rx: 5px;}
:root {
--sizelg:1.25rem;
	--size0: 1.15rem;
	--size1: .925rem;
	--size2: .8rem;
	--size3: .75rem;
	--size4: .7rem;
	--size5: .5rem;
	--size6: .35rem;

    --SD-bgR: 10; /* RED value | 0 - 255 | DEFAULT: 10 */
    --SD-bgG: 10; /* GREEN value | 0 - 255 | DEFAULT: 10 */
    --SD-bgB: 10; /* BLUE value | 0 - 255 | DEFAULT: 10 */


    --SD-accent: 33,150,243;


    --SD-font: 'Roboto';
  --bg1: rgba( var(--SD-bgR), var(--SD-bgG), var(--SD-bgB), 1);
  --bg2: rgba( calc(var(--SD-bgR) * 1.5), calc(var(--SD-bgG) * 1.5), calc(var(--SD-bgB) * 1.5), 1);
  --bg3: rgba( calc(var(--SD-bgR) * 2), calc(var(--SD-bgG) * 2), calc(var(--SD-bgB) * 2), 1);
  --bg4: rgba( calc(var(--SD-bgR) * 2.5), calc(var(--SD-bgG) * 2.5), calc(var(--SD-bgB) * 2.5), 1);
  --bg5: rgba( calc(var(--SD-bgR) * 3), calc(var(--SD-bgG) * 3), calc(var(--SD-bgB) * 3), 1);
  --bg6: rgba( calc(var(--SD-bgR) * 3.5), calc(var(--SD-bgG) * 3.5), calc(var(--SD-bgB) * 3.5), 1);
  --bg7: rgba( calc(var(--SD-bgR) * 4), calc(var(--SD-bgG) * 4), calc(var(--SD-bgB) * 4), 1);
  --bg8: rgba( calc(var(--SD-bgR) * 4.5), calc(var(--SD-bgG) * 4.5), calc(var(--SD-bgB) * 4.5), 1);
  --bg9: rgba( calc(var(--SD-bgR) * 5), calc(var(--SD-bgG) * 5), calc(var(--SD-bgB) * 5), 1);
  --bg10: rgba( calc(var(--SD-bgR) * 5.5), calc(var(--SD-bgG) * 5.5), calc(var(--SD-bgB) * 5.5), 1);
  --bg11: rgba( calc(var(--SD-bgR) * 6), calc(var(--SD-bgG) * 6), calc(var(--SD-bgB) * 6), 1);
  --bg12: rgba( calc(var(--SD-bgR) * 6.5), calc(var(--SD-bgG) * 6.5), calc(var(--SD-bgB) * 6.5), 1);
  --bg13: rgba( calc(var(--SD-bgR) * 7), calc(var(--SD-bgG) * 7), calc(var(--SD-bgB) * 7), 1);
  --bg14: rgba( calc(var(--SD-bgR) * 7.5), calc(var(--SD-bgG) * 7.5), calc(var(--SD-bgB) * 7.5), 1);
  --bg15: rgba( calc(var(--SD-bgR) * 8), calc(var(--SD-bgG) * 8), calc(var(--SD-bgB) * 8), 1);
  --SD-accent-default: 33,150,243;
  --SD-accent-set: var(--SD-accent, var(--SD-accent-default));
  --text-link: rgba(var(--SD-accent-set), 1);
  --green: #43b581;a
  --greenDark: #359066;
  --yellow: #faa61a;
  --yellowDark: #dc8b05;
  --red: #f04747;
  --redDark: #b63b3b;
  --purple: #593695;
  --purpleDark: #432870;
  --blurple: #297EC0;
  --nitro: #ff73fa;
  --TB-position-top: calc(var(--server-size) + 20px) ;
}
#app-mount .wrapper-3t9DeA[aria-label*=mobile]:after {
  content: "";
  -webkit-mask: url("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0Ij4gICAgPHBhdGggZD0iTTE1LjUgMWgtOEM2LjEyIDEgNSAyLjEyIDUgMy41djE3QzUgMjEuODggNi4xMiAyMyA3LjUgMjNoOGMxLjM4IDAgMi41LTEuMTIgMi41LTIuNXYtMTdDMTggMi4xMiAxNi44OCAxIDE1LjUgMXptLTQgMjFjLS44MyAwLTEuNS0uNjctMS41LTEuNXMuNjctMS41IDEuNS0xLjUgMS41LjY3IDEuNSAxLjUtLjY3IDEuNS0xLjUgMS41em00LjUtNEg3VjRoOXYxNHoiLz4gICAgPHBhdGggZD0iTTAgMGgyNHYyNEgweiIgZmlsbD0ibm9uZSIvPjwvc3ZnPg==");
  -webkit-mask-size: 16px;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-position: center;
  display: block;
  position: absolute;
  width: 12px;
  height: 16px;
  top: 50%;
  transform: translateY(-50%);
  right: -185px;
  background: var(--blurple);
  z-index: 1;
}

@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
@import url("https://discordstyles.github.io/MinimalCord/base.css");

:root {
    /*
        Accent variable
        Use this website: https://htmlcolorcodes.com/color-picker/
        to get your desired RGB numbers. Then simply put each number in their respective area.
        R,G,B
    */
    --accent: 50, 131, 207;

    --message-padding: 10px; /* Spacing in the messages. MUST END IN px | DEFAULT: 10px */
    --message-spacing: 10px; /* Spacing around the messages. MUST END IN px | DEFAULT: 10px */

    /*
        To use a custom font. Visit https://fonts.google.com and select one to your liking.
        Now just follow this tutorial: https://imgur.com/a/CNbw7xC
    */
    --font: 'Roboto';
}
:root {
  --border-radius: 5px;
  --discord-green: 67 181 129;
  --discord-yellow: 219 171 9;
  --discord-red: 215 58 73;
  --discord-purple: 89 54 149;
  --discord-invisible: 117 128 142;
  --discord-nitro: 255 115 250;
  --discord-blurple: 114 137 218;
  --discord-spotify: 29 185 84;
  --discord-twitch: 89 54 149;
  --discord-xbox: 16 124 16;
  --background-modifier-selected: var(--background-light);
  --background-modifier-hover: var(--background-alt);
  --background-modifier-active: var(--background-light);
  --channels-default: var(--text-normal);
  --version: "2.0.7";
}

.theme-light {
  --background-light: #fff;
  --background-light-alt: #fff;
  --background: #edf2f7;
  --background-alt: #f7fafc;
  --background-dark: #e2e8f0;
  --text-normal: #2d3748;
  --text-muted: #718096;
  --text-focus: #1a202c;
  --font-weight-light: 400;
  --font-weight-normal: 500;
  --font-weight-semibold: 700;
  --font-weight-bold: 700;
  --box-shadow: 0 4px 9px rgba(0 0 0 / 0.2);
  --box-shadow-alt: 0 2px 5px rgba(0 0 0 / 0.1);
  --scrollbar-colour: rgba(0 0 0 / 0.2);
  --edit-message-box: var(--background-light);
  --message-background: var(--background-light);
}

.theme-dark {
  --background-light: #1D232E;
  --background-light-alt: #1f2329;
  --background: #11161F;
  --background-alt: #171C25;
  --background-dark: #0D1119;
  --text-normal: #d1d1d2;
  --text-muted: #686a6d;
  --text-focus: #fff;
  --font-weight-light: 300;
  --font-weight-normal: 400;
  --font-weight-semibold: 500;
  --font-weight-bold: 700;
  --box-shadow: 0 4px 9px rgba(0 0 0 / 0.4);
  --box-shadow-alt: 0 2px 5px rgba(0 0 0 / 0.3);
  --scrollbar-colour: var(--background-light);
  --edit-message-box: var(--background-light);
  --message-background: var(--background-alt);
}

#app-mount .bg-h5JY_x {
  background: var(--background-dark);
}

::selection {
  background: rgba(var(--accent), 1);
  color: #fff;
}

::-webkit-input-placeholder, body, button, input, select, textarea {
  font-family: var(--font, "Roboto"), "Whitney";
}

html, span:not([class*=spinner-]):not([class*=spinnerItem]) {
  -webkit-backface-visibility: hidden !important;
          backface-visibility: hidden !important;
}

#app-mount .title-3qD0b-,
#app-mount .container-1r6BKw {
  background: var(--background);
}
#app-mount .children-19S4PO:after {
  content: none;
}
#app-mount .searchBar-3dMhjb {
  background: var(--background-dark);
}

::-webkit-scrollbar {
  width: 8px !important;
  height: 8px !important;
}

::-webkit-scrollbar,
::-webkit-scrollbar-track,
::-webkit-scrollbar-track-piece {
  border-color: transparent !important;
  background: transparent !important;
}

::-webkit-scrollbar-thumb {
  border-radius: var(--border-radius) !important;
  border: none !important;
  background-clip: content-box !important;
  background: var(--scrollbar-colour) !important;
}

::-webkit-scrollbar-corner {
  visibility: hidden !important;
}

.scrollerThemed-2oenus.themeHidden-2yP93k .scroller-2FKFPG::-webkit-scrollbar,
.scrollerThemed-2oenus.themeHidden-2yP93k .scroller-2FKFPG::-webkit-scrollbar-corner,
.scrollerThemed-2oenus.themeHidden-2yP93k .scroller-2FKFPG::-webkit-scrollbar-thumb,
.scrollerThemed-2oenus.themeHidden-2yP93k .scroller-2FKFPG::-webkit-scrollbar-track {
  display: none !important;
}

.scroller-1JbKMe,
.scroller-305q3I {
  background: transparent;
}

#app-mount .tooltipPrimary-1d1ph4 {
  background: var(--background-light);
  box-shadow: var(--box-shadow);
}
#app-mount .tooltipPointer-3ZfirK {
  border-top-color: var(--background-light);
}
#app-mount .tooltipContent-bqVLWK {
  color: var(--text-focus);
  font-weight: var(--font-weight-bold);
}

#app-mount .info-1VyQPT .colorMuted-HdFt4q:first-child:before {
  content: "MinimalCord " var(--version) " [BETA]";
  display: block;
}

#app-mount .guilds-1SWlCJ {
  background: var(--background-dark);
}
#app-mount .guilds-1SWlCJ .scroller-2TZvBN {
  background: var(--background-dark);
}
#app-mount .guilds-1SWlCJ .scroller-2TZvBN::-webkit-scrollbar {
  display: none;
}

#app-mount .wrapper-1BJsBx.selected-bZ3Lue .childWrapper-anI2G9 {
  background: rgb(var(--accent), 1);
}
#app-mount .childWrapper-anI2G9 {
  background: var(--background-light);
}
#app-mount .circleIconButton-jET_ig {
  background: var(--background-light);
}
#app-mount .circleIconButton-jET_ig:hover {
  background: rgb(var(--discord-green)/1);
}

#app-mount .expandedFolderBackground-2sPsd- {
  z-index: -1;
  background: var(--background-light);
}
#app-mount .folder-21wGz3 {
  background: var(--background-light);
}

#app-mount .container-3w7J-x,
#app-mount .sidebar-2K8pFh {
  background: var(--background);
}

#app-mount .panels-j1Uci_ {
  background: var(--background);
}
#app-mount .container-1giJp5 {
  border: none;
}

#app-mount .wrapper-2jXpOf {
  height: auto;
  margin-bottom: 2px;
}
#app-mount .wrapper-2jXpOf.modeMuted-onO3r- .name-23GUGE {
  color: var(--text-muted);
}
#app-mount .wrapper-2jXpOf.modeUnread-1qO3K1 .icon-1DeIlz {
  color: var(--text-focus);
}
#app-mount .wrapper-2jXpOf.modeSelected-346R90 .icon-1DeIlz {
  color: var(--text-focus);
}
#app-mount .wrapper-2jXpOf.modeSelected-346R90:before {
  content: "";
  position: absolute;
  top: 1px;
  height: calc(100% - 2px);
  width: 4px;
  background: rgb(var(--accent), 1);
  z-index: 1;
}
#app-mount .content-1x5b-n {
  margin-left: 0;
  border-radius: 0 var(--border-radius) var(--border-radius) 0;
  padding-left: 16px;
}
#app-mount .unread-2lAfLh {
  z-index: 2;
}
#app-mount .avatarSpeaking-2IGMRN {
  box-shadow: inset 0 0 0 2px rgba(var(--accent), 1), inset 0 0 0 3px var(--background);
}

#app-mount .selected-31Nl7x .header-2V-4Sw {
  background: transparent;
}
#app-mount .header-2V-4Sw {
  box-shadow: none;
}
#app-mount .header-2V-4Sw:hover {
  background: transparent;
}

#app-mount .sidebar-2K8pFh .bar-30k2ka {
  border-radius: var(--border-radius);
  background: var(--background-light);
  box-shadow: var(--box-shadow);
}

#app-mount .chat-3bRxxu {
  background: var(--background);
}
#app-mount .chat-3bRxxu .scrollerSpacer-avRLaA {
  height: 25px;
}
#app-mount .chat-3bRxxu .content-yTz4x3:before {
  content: none;
}
#app-mount .operations-36ENbA > a {
  color: rgb(var(--accent), 1);
}

#app-mount .form-2fGMdU:before {
  content: none;
}
#app-mount .scrollableContainer-2NUZem {
  background: var(--background-alt);
  box-shadow: var(--box-shadow);
  border-radius: var(--border-radius);
}
#app-mount .placeholder-37qJjk {
  text-transform: uppercase;
  font-weight: bold;
  letter-spacing: 1.5px;
  font-size: 12px;
}
#app-mount .placeholder-37qJjk,
#app-mount .slateTextArea-1Mkdgw {
  padding: 15px;
}
#app-mount .attachButton-2WznTc {
  padding: 15px 16px;
  height: 52px;
}
#app-mount .buttons-3JBrkn {
  height: 52px;
}

#app-mount .message-2qnXI6 .scrollableContainer-2NUZem {
  background: var(--edit-message-box);
  box-shadow: none;
}
#app-mount .cozy-3raOZG {
  background: transparent;
  padding-top: var(--message-padding);
  padding-bottom: var(--message-padding);
  padding-left: 0;
  margin-left: 16px;
  margin-right: 8px;
  position: relative;
}
#app-mount .cozy-3raOZG:before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: var(--message-border-radius, var(--border-radius));
  background: var(--background-alt);
  z-index: -1;
}
#app-mount .cozy-3raOZG .contents-2mQqc9,
#app-mount .cozy-3raOZG .container-1ov-mD {
  margin-left: calc(40px + (var(--message-padding) * 2));
}
#app-mount .cozy-3raOZG .avatar-1BDn8e {
  left: var(--message-padding);
  top: var(--message-padding);
  margin-top: 0;
}
#app-mount .cozy-3raOZG.groupStart-23k01U {
  margin-top: var(--message-spacing);
}
#app-mount .cozy-3raOZG + .cozy-3raOZG:not(.groupStart-23k01U) {
  margin-top: calc(var(--message-padding) / -1);
  padding-top: 0.175rem;
}
#app-mount .cozy-3raOZG .messageContent-2qWWxC {
  margin-left: -5px;
  padding-left: 5px;
}
#app-mount .cozy-3raOZG .wrapper-2aW0bm {
  background: var(--background-light);
  height: 24px;
  box-shadow: var(--box-shadow-alt);
}
#app-mount .cozy-3raOZG .button-1ZiXG9 {
  height: 24px;
  width: 24px;
  padding: 0;
}
#app-mount .cozy-3raOZG .button-1ZiXG9 svg {
  width: 14px;
  height: 14px;
}
#app-mount .cozy-3raOZG .button-1ZiXG9:hover {
  background: rgba(var(--accent), 1);
  color: #fff;
}
#app-mount .cozy-3raOZG .button-1ZiXG9.dangerous-2r8KxV:hover {
  background: rgba(var(--discord-red)/1);
}
#app-mount .cozy-3raOZG .timestamp-3ZCmNB.alt-1uNpEt {
  width: calc(40px + var(--message-padding));
  display: flex;
  justify-content: center;
}
#app-mount .cozy-3raOZG.mentioned-xhSam7 .messageContent-2qWWxC {
  position: relative;
}
#app-mount .cozy-3raOZG.mentioned-xhSam7 .messageContent-2qWWxC:after {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 0 var(--border-radius) 0 0;
  height: 100%;
  width: calc(100% - var(--message-padding));
  border-left: 2px solid rgba(var(--discord-yellow)/1);
  background: var(--background-mentioned);
  pointer-events: none;
}
#app-mount .cozy-3raOZG.mentioned-xhSam7 .container-1ov-mD {
  position: relative;
}
#app-mount .cozy-3raOZG.mentioned-xhSam7 .container-1ov-mD:before {
  content: "";
  position: absolute;
  pointer-events: none;
  top: 0;
  left: -5px;
  height: 100%;
  width: calc(100% - var(--message-padding) + 5px);
  border-left: 2px solid rgba(var(--discord-yellow)/1);
  background: var(--background-mentioned);
  border-radius: 0 0 var(--border-radius) 0;
}
#app-mount .cozy-3raOZG .repliedMessage-VokQwo {
  margin-left: calc(var(--message-padding) + 56px);
}
#app-mount .cozy-3raOZG .repliedMessage-VokQwo + .contents-2mQqc9 .avatar-1BDn8e, #app-mount .cozy-3raOZG .repliedMessage-VokQwo + .contents-2mQqc9 img {
  top: 32px;
}
#app-mount .cozy-3raOZG .repliedMessage-VokQwo:before {
  border-color: var(--text-muted);
}
#app-mount .hljs-comment {
  color: var(--text-muted);
}
#app-mount .wrapper-3WhCwL {
  background: rgba(var(--accent), 0.1);
  color: rgba(var(--accent), 1);
}
#app-mount .wrapper-3WhCwL:hover, #app-mount .wrapper-3WhCwL.popout-open {
  background: rgba(var(--accent), 1);
  color: #fff;
}
#app-mount .wrapper-3vR61M {
  background: transparent;
}
#app-mount .wrapper-1F5TKx {
  background: transparent;
  padding-top: var(--message-padding);
  padding-bottom: var(--message-padding);
  padding-left: 0;
  margin-left: 16px;
  margin-right: 8px;
  position: relative;
}
#app-mount .wrapper-1F5TKx:before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  border-radius: var(--message-border-radius, var(--border-radius));
  background: var(--background-alt);
  z-index: -1;
}
#app-mount .wrapper-1F5TKx .contents-1R-xLu,
#app-mount .wrapper-1F5TKx .attachmentContainer-2BK1nK {
  padding-left: calc(40px + (var(--message-padding) * 2));
}
#app-mount .wrapper-1F5TKx .avatar-1BDn8e {
  left: var(--message-padding);
  top: var(--message-padding);
  margin-top: 0;
}
#app-mount .wrapper-1F5TKx[style*=margin-top] {
  margin-top: var(--message-spacing) !important;
}
#app-mount .wrapper-1F5TKx + .wrapper-1F5TKx:not([style*=margin-top]) {
  margin-top: calc(var(--message-padding) / -1);
  padding-top: 0.175rem;
}
#app-mount .embedFull-2tM8-- {
  background: var(--background-dark);
}
#app-mount .attachment-33OFj0,
#app-mount .wrapperAudio-1jDe0Q {
  background: var(--background-dark);
  border-radius: var(--border-radius);
  border: none;
}
#app-mount pre code,
#app-mount code.inline {
  background: var(--background-dark);
  border-radius: var(--border-radius);
  border: none;
}

#app-mount .divider-JfaTT5.isUnread-3Ef-o9 {
  margin: calc(var(--message-padding) / -1 - 1px) 8px calc(var(--message-padding) / -1) calc(55px + (var(--message-padding) * 2));
  height: 0;
  top: 0;
}
#app-mount .divider-JfaTT5.isUnread-3Ef-o9.beforeGroup-1rH1F0 {
  margin: var(--message-spacing) 8px var(--message-spacing) 20px;
}
#app-mount .divider-JfaTT5.hasContent-1cNJDh {
  margin: var(--message-spacing) 0 var(--message-spacing) 20px;
}
#app-mount .divider-JfaTT5.hasContent-1cNJDh .content-1o0f9g {
  background: var(--background-light);
  padding: 4px 8px;
  line-height: normal;
  font-weight: var(--font-weight-semibold);
  border-radius: var(--border-radius);
}
#app-mount .divider-JfaTT5.hasContent-1cNJDh:not(.isUnread-3Ef-o9) {
  border-top: none;
  height: auto;
}
#app-mount .divider-JfaTT5.hasContent-1cNJDh:not(.isUnread-3Ef-o9):before {
  content: "";
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 100%;
  background: var(--background-light);
  height: 1px;
  z-index: -1;
}

#app-mount .newMessagesBar-265mhP {
  background: rgba(var(--accent), 1);
  border-radius: var(--border-radius);
  top: 10px;
  left: 26px;
  right: 26px;
}
#app-mount .jumpToPresentBar-G1R9s6 {
  background: var(--background-light);
  opacity: 1;
  border-radius: var(--border-radius);
  left: auto;
  box-shadow: var(--box-shadow);
  bottom: 20px;
  padding-bottom: 0;
}
#app-mount .jumpToPresentBar-G1R9s6 .barButtonMain-3K-jeJ {
  display: none;
}
#app-mount .jumpToPresentBar-G1R9s6 .barButtonBase-2uLO1z {
  padding: 10px;
  height: auto;
  line-height: normal;
}
#app-mount .jumpToPresentBar-G1R9s6 .spinner-1AwyAQ {
  padding-left: 12px;
}

#app-mount .members-1998pB {
  background: transparent;
}
#app-mount .members-1998pB > div {
  background: transparent;
}

#app-mount .member-3-YXUe .botTagRegular-2HEhHi {
  background: rgba(var(--accent), 1);
}
#app-mount .member-3-YXUe:hover .layout-2DM8Md {
  background: var(--background-alt);
}
#app-mount .member-3-YXUe:active .layout-2DM8Md {
  background: var(--background-light);
}
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md {
  background: rgba(var(--accent), 1);
}
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md .roleColor-rz2vM0,
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md .activity-2Gy-9S,
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md .premiumIcon-1rDbWQ {
  color: #fff !important;
}
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md rect[fill="#43b581"],
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md rect[fill="#FD6F6F"],
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md rect[fill="#f04747"] {
  fill: #fff;
}
#app-mount .member-3-YXUe.selected-aXhQR6 .layout-2DM8Md .botTagRegular-2HEhHi {
  background: #fff;
  color: rgba(var(--accent), 1);
}

#app-mount .userPopout-3XzG_A {
  box-shadow: var(--box-shadow);
  border-radius: var(--border-radius);
}
#app-mount .userPopout-3XzG_A .headerTag-2pZJzA,
#app-mount .userPopout-3XzG_A .headerText-1HLrL7,
#app-mount .userPopout-3XzG_A .content-3JfFJh,
#app-mount .userPopout-3XzG_A .text-AOoUen,
#app-mount .userPopout-3XzG_A .customStatus-1bh2V9,
#app-mount .userPopout-3XzG_A .headerTagUsernameNoNickname-2_H881 {
  color: var(--text-normal);
}
#app-mount .userPopout-3XzG_A .activityName-1IaRLn,
#app-mount .userPopout-3XzG_A .nameNormal-2lqVQK,
#app-mount .userPopout-3XzG_A .nameWrap-3Z4G_9 {
  color: var(--text-focus);
}
#app-mount .userPopout-3XzG_A .headerNormal-T_seeN {
  background: var(--background);
}
#app-mount .userPopout-3XzG_A .activity-11LB_k {
  background: rgba(0, 0, 0, 0.025);
}
#app-mount .userPopout-3XzG_A .body-3iLsc4 {
  background: var(--background-alt);
}
#app-mount .userPopout-3XzG_A .footer-1fjuF6 {
  background: var(--background-alt);
  padding-bottom: 0;
}
#app-mount .userPopout-3XzG_A .note-3HfJZ5 {
  margin: 0;
}
#app-mount .userPopout-3XzG_A .textarea-2r0oV8:focus {
  background: var(--background-dark);
}
#app-mount .userPopout-3XzG_A .input-2_SIlA {
  background: var(--background-dark);
  border: none;
  font-weight: var(--font-weight-semibold);
  margin-bottom: 20px;
}
#app-mount .userPopout-3XzG_A .protip-YaFfgO {
  display: none;
}
#app-mount .role-2irmRk {
  position: relative;
  z-index: 1;
  overflow: hidden;
  border: none;
}
#app-mount .roleCircle-3xAZ1j::after {
  content: "";
  position: absolute;
  height: 24px;
  width: 100%;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  background: inherit;
  opacity: 0.3;
  z-index: -1;
}
#app-mount .headerPlaying-j0WQBV {
  background: var(--background);
}
#app-mount .headerSpotify-zpWxgT {
  background: var(--background);
}
#app-mount .headerSpotify-zpWxgT .button-2IFFQ4 {
  background: rgba(var(--discord-spotify)/1);
  border: none;
  transition: box-shadow 0.15s ease;
}
#app-mount .headerSpotify-zpWxgT .button-2IFFQ4:hover, #app-mount .headerSpotify-zpWxgT .button-2IFFQ4:focus {
  box-shadow: inset 0 0 0 100vmax rgba(0, 0, 0, 0.15);
}
#app-mount .barInner-3NDaY_ {
  background: rgb(var(--discord-spotify));
}

.theme-light .menu-3sdvDG {
  background: var(--background-light);
}

.theme-dark .menu-3sdvDG {
  background: var(--background-dark);
}

#app-mount .menu-3sdvDG {
  box-shadow: var(--box-shadow);
}
#app-mount .item-1tOPte {
  line-height: normal;
}
#app-mount .item-1tOPte:active, #app-mount .item-1tOPte.focused-3afm-j:not(.colorDanger-2qLCe1) {
  background: rgba(var(--accent), 1);
}
#app-mount .item-1tOPte.colorPremium-p4p7qO {
  color: rgba(var(--discord-nitro)/1);
}
#app-mount .item-1tOPte.colorPremium-p4p7qO.focused-3afm-j {
  color: #fff;
  background: rgba(var(--discord-nitro)/1);
}

#app-mount .messagesPopoutWrap-1MQ1bW {
  background: var(--background-light);
  box-shadow: var(--box-shadow);
  border-radius: var(--border-radius);
}
#app-mount .header-ykumBX {
  background: var(--background-alt);
  box-shadow: var(--box-shadow);
  z-index: 2;
}
#app-mount .messageGroupWrapper-o-Zw7G {
  background: var(--background-alt);
  border: none;
}
#app-mount .messageGroupCozy-2iY6cT {
  margin-left: 0;
  margin-right: 0;
}

#app-mount .container-3ayLPN {
  background: var(--background-light);
  box-shadow: var(--box-shadow);
}
#app-mount .option-96V44q:after {
  background: linear-gradient(90deg, transparent, var(--background-light));
}
#app-mount .option-96V44q.selected-rZcOL- {
  background: var(--background-alt);
}

#app-mount .searchResultsWrap-3-pOjs {
  background: var(--background-alt);
  border-top-left-radius: var(--border-radius);
}
#app-mount .searchHeader-2XoQg7 {
  background: var(--background-light);
  box-shadow: var(--box-shadow-alt);
}
#app-mount .channelName-1JRO3C {
  background: var(--background-alt);
}
#app-mount .searchResult-9tQ1uo {
  border: none;
  background: var(--background-light);
}
#app-mount .searchResultMessage-1fxgXh .cozy-3raOZG {
  margin: 0;
}
#app-mount .searchResultMessage-1fxgXh:not(.hit-1fVM9e) .cozy-3raOZG:before {
  content: none;
}
#app-mount .searchResultMessage-1fxgXh.hit-1fVM9e {
  box-shadow: 0 0 10px 6px var(--background-alt);
  border: none;
  border-radius: var(--border-radius);
}
#app-mount .searchResultMessage-1fxgXh.hit-1fVM9e .cozy-3raOZG {
  background: var(--background-light);
}

#app-mount .privateChannels-1nO12o {
  background: transparent;
}
#app-mount .channel-2QD9_O {
  margin-left: 0;
  border-radius: 0;
  padding: 0;
  margin-bottom: 3px;
}
#app-mount .channel-2QD9_O .layout-2DM8Md {
  border-radius: 0 var(--border-radius) var(--border-radius) 0;
  padding-left: 16px;
}
#app-mount .channel-2QD9_O.selected-aXhQR6 .layout-2DM8Md:before {
  content: "";
  position: absolute;
  left: 0;
  width: 4px;
  height: 100%;
  background: rgba(var(--accent), 1);
}

#app-mount .container-1D34oG {
  background: var(--background);
}
#app-mount .tabBody-3YRQ8W:before {
  content: none;
}
#app-mount .title-30qZAO {
  margin: 20px;
}
#app-mount .peopleListItem-2nzedh {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  border: none;
  line-height: normal;
  margin: 0 20px 10px 20px;
  padding: 0 15px;
}
#app-mount .peopleListItem-2nzedh:hover {
  background: var(--background-light);
}
#app-mount .peopleListItem-2nzedh:hover .actionButton-uPB8Fs {
  background: var(--background);
}
#app-mount .actionButton-uPB8Fs {
  background: var(--background-dark);
}
#app-mount .nowPlayingColumn-2sl4cE {
  background: transparent;
}
#app-mount .nowPlayingScroller-2XrVUt {
  padding: 20px;
}
#app-mount .header-13Cw0- {
  padding: 0 0 20px 0;
}
#app-mount .emptyCard-1RJw8n {
  background: var(--background-alt);
  border-radius: var(--border-radius);
}
#app-mount .wrapper-3D2qGf {
  background: var(--background-alt);
  border-radius: var(--border-radius);
}
#app-mount .wrapper-3D2qGf:hover {
  background: var(--background-light);
}
#app-mount .wrapper-3D2qGf:hover .inset-3sAvek {
  background: var(--background-alt);
}
#app-mount .inset-3sAvek {
  background: var(--background);
}

#app-mount .lookFilled-1Gx00P.colorBrand-3pXr91 {
  background: rgba(var(--accent), 1);
  transition: box-shadow 0.2s ease;
}
#app-mount .lookFilled-1Gx00P.colorBrand-3pXr91:hover {
  box-shadow: inset 0 0 0 100vmax rgba(0, 0, 0, 0.1);
}
#app-mount .lookOutlined-3sRXeN.colorWhite-rEQuAQ {
  border-color: var(--text-normal);
  color: var(--text-normal);
}
#app-mount .button-1YfofB.buttonColor-7qQbGO {
  background: var(--background-light);
}
#app-mount .button-1YfofB.buttonColor-7qQbGO:hover {
  background: rgba(var(--accent), 1);
  color: #fff;
}

#app-mount .input-cIJ7To {
  background: var(--background-dark);
  border: 1px solid var(--background-dark);
  border-radius: var(--border-radius);
}
#app-mount .input-cIJ7To:hover {
  border-color: var(--background-light);
}
#app-mount .input-cIJ7To:focus {
  border-color: rgba(var(--accent), 1);
}

#app-mount .css-gvi9bl-control,
#app-mount .css-17e1tep-control {
  background: var(--background);
  border-radius: var(--border-radius);
  border-color: var(--background);
  cursor: pointer;
}
#app-mount .css-gvi9bl-control:hover,
#app-mount .css-17e1tep-control:hover {
  border-color: var(--background-light);
}
#app-mount .css-6fzn47-control {
  background: var(--background);
  border-radius: var(--border-radius);
  border-color: rgba(var(--accent), 1);
}

#app-mount [role=radiogroup] .item-26Dhrx {
  background: var(--background-alt);
}
#app-mount [role=radiogroup] .item-26Dhrx:hover {
  background: var(--background-light);
}
#app-mount [role=radiogroup] .item-26Dhrx[aria-checked=true] {
  background: rgb(var(--accent));
  color: #fff;
}
#app-mount [role=radiogroup] .item-26Dhrx[aria-checked=true] .radioIconForeground-XwlXQN {
  color: #fff;
}

#app-mount .barFill-23-gu- {
  background: rgba(var(--accent), 1);
}

#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] {
  background: var(--background);
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > .marginBottom40-2vIwTv:not(.divider-3573oO) {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
  border: none;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > .marginBottom40-2vIwTv:not(.divider-3573oO) .marginTop8-1DLZ1n {
  margin-top: 0;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > .marginBottom20-32qID7:not(.title-3sZWYQ) {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
  border: none;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > [class*=marginBottom] .container-2_Tvc_:last-child {
  margin-bottom: 0;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > [class*=marginBottom] [class*=marginBottom] {
  padding: 0;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy > .divider-3wNib3 {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
  border: none;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .children-rWhLdy .children-rWhLdy .flex-1xMQg5.flex-1O1GKY {
  padding: 0 !important;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .divider-3573oO {
  display: none;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .formNotice-2_hHWR {
  padding: 0;
  background: transparent;
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .sidebarRegionScroller-3MXcoP {
  background: var(--background-dark);
}
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .contentRegionScroller-26nc1e,
#app-mount .layer-3QrUeG[aria-label*=_SETTINGS] .contentRegion-3nDuYy {
  background: var(--background);
}

#app-mount [aria-label=USER_SETTINGS] .background-1QDuV2 {
  background: var(--background-alt);
  border-radius: var(--border-radius);
}
#app-mount [aria-label=USER_SETTINGS] .fieldList-21DyL8 {
  background: var(--background-light);
}
#app-mount [aria-label=USER_SETTINGS] .authedApp-mj2Hmd {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  border: none;
}
#app-mount [aria-label=USER_SETTINGS] .accountBtnInner-sj5jLs {
  background-color: var(--background-light);
}
#app-mount [aria-label=USER_SETTINGS] .connection-1fbD7X {
  background: var(--background-alt);
}
#app-mount [aria-label=USER_SETTINGS] .connectionHeader-2MDqhu {
  background: var(--background-light-alt);
}
#app-mount [aria-label=USER_SETTINGS] .integration-3kMeY4 {
  background: var(--background);
}
#app-mount [aria-label=USER_SETTINGS] .accountList-33MS45 {
  background: var(--background-alt);
}
#app-mount [aria-label=USER_SETTINGS] .children-rWhLdy > .flex-1xMQg5.flex-1O1GKY {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
}
#app-mount [aria-label=USER_SETTINGS] .micTest-cP1_6S {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  padding: 16px;
  margin-top: 20px;
}
#app-mount [aria-label=USER_SETTINGS] .micTest-cP1_6S .marginTop8-1DLZ1n {
  margin-top: 0;
}
#app-mount [aria-label=USER_SETTINGS] .container-3PXSwK {
  width: 530px !important;
}
#app-mount [aria-label=USER_SETTINGS] .notches-1sAcEM {
  background: none;
}

#app-mount [aria-label=GUILD_SETTINGS] [data-list-id=audit-log] {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  margin-top: 20px;
}
#app-mount [aria-label=GUILD_SETTINGS] [data-list-id=audit-log] [role=listitem] {
  background: transparent;
}
#app-mount [aria-label=GUILD_SETTINGS] [data-list-id=audit-log] [role=listitem][aria-expanded=true] {
  background: var(--background-light);
}
#app-mount [aria-label=GUILD_SETTINGS] .auditLog-3jNbM6 {
  border: none;
  margin: 0;
}
#app-mount [aria-label=GUILD_SETTINGS] .auditLog-3jNbM6 .divider-1pnAR2 {
  display: none;
}
#app-mount [aria-label=GUILD_SETTINGS] .auditLog-3jNbM6:hover {
  background: var(--background-light);
}
#app-mount [aria-label=GUILD_SETTINGS] .headerExpanded-CUEwZ5,
#app-mount [aria-label=GUILD_SETTINGS] .changeDetails-bk98pu {
  background: var(--background-light);
}

#app-mount .quickswitcher-3JagVE {
  background: var(--background);
}
#app-mount .scroller-zPkAnE {
  background: transparent;
}
#app-mount .input-2VB9rf {
  background: var(--background-light);
  box-shadow: var(--box-shadow);
  padding: 0 24px;
}

#app-mount .root-SR8cQa .topSectionNormal-2-vo2m {
  background: var(--background-alt);
}
#app-mount .root-SR8cQa .topSectionPlaying-1J5E4n {
  background: var(--background-alt);
}
#app-mount .root-SR8cQa .headerFill-adLl4x {
  background: transparent;
}
#app-mount .root-SR8cQa .tabBarContainer-1s1u-z {
  border: none;
}
#app-mount .root-SR8cQa .userInfoSection-2acyCx {
  border: none;
}
#app-mount .root-SR8cQa .connectedAccounts-repVzS {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-gap: 16px;
}
#app-mount .root-SR8cQa .connectedAccount-36nQx7 {
  background: var(--background-alt);
  border-radius: var(--border-radius);
  border: none;
  margin: 0;
  width: 100%;
  box-sizing: border-box;
}
#app-mount .root-SR8cQa .body-3ND3kc {
  background: var(--background);
  height: 320px;
}
#app-mount .root-SR8cQa .note-QfFU8y {
  margin: 0;
}
#app-mount .root-SR8cQa textarea {
  padding: 8px;
  height: auto !important;
}
/*---------------------------------------- BACKGROUND ----------------------------------------*/
body {
    background: url("https://media.discordapp.net/attachments/810707389962911804/822484547433660476/Black_Box.png?width=1168&height=701");
    background-attachment: fixed;
    background-position: center;
    background-size: cover;
}
.appMount-3lHmkl {
    background: rgba(0, 0, 0, .6);
}
/*---------------------------------------- REMOVE DARK & WHITE THEME BACKGROUNDS ----------------------------------------*/
.theme-dark,
.theme-light {
    --background-message-hover: rgba(23, 26, 31,0);
    --header-primary: #fff;
    --header-secondary: #b9bbbe;
    --text-normal: #dcddde;
    --text-muted: #9d9d9d;
    --channels-default: #8e9297;
    --interactive-normal: #b9bbbe;
    --interactive-hover: #dcddde;
    --interactive-active: #fff;
    --interactive-muted: #4f545c;
    --background-primary: #171C25;
    --background-secondary: #11161F;
    --background-tertiary: #11161F;
    --background-accent: #11161F
    --background-floating: rgba(23, 26, 31,0);
    --activity-card-background: #11161F;
    --deprecated-panel-background: #11161F;

}
/* User popout animation */
.headerPlaying-j0WQBV.header-2BwW8b, .headerSpotify-zpWxgT.header-2BwW8b, .headerStreaming-2FjmGz.header-2BwW8b, .headerXbox-3G-4PF.header-2BwW8b { padding-bottom: 30px;}.headerPlaying-j0WQBV.header-2BwW8b:after, .headerSpotify-zpWxgT.header-2BwW8b:after, .headerStreaming-2FjmGz.header-2BwW8b:after, .headerXbox-3G-4PF.header-2BwW8b:after { background: url('https://cdn.discordapp.com/attachments/787050568107556864/823058109038723142/wave.png'); background-size: 250px 20px; animation: animate 6s linear infinite !important; opacity: 1 !important;}.header-2BwW8b:after, .headerPlaying-j0WQBV:before, .headerSpotify-zpWxgT:before, .headerStreaming-2FjmGz:before, .headerXbox-3G-4PF:before { position: absolute;content: "";bottom: -1px;left: 0;width: 250px;height: 20px;z-index: -1;animation: animate2 6s linear infinite;animation-delay: 0s;opacity: 0.5;}.headerPlaying-j0WQBV:before { background: url('https://media.discordapp.net/attachments/787050568107556864/823058460253093928/wave_playing.png'); background-size: 250px 20px;}.headerSpotify-zpWxgT:before { background: url('https://media.discordapp.net/attachments/787050568107556864/823058685739270194/wave_spotify.png'); background-size: 250px 20px;}.headerStreaming-2FjmGz:before { background: url('https://media.discordapp.net/attachments/787050568107556864/823058928195469322/wave_streaming.png'); background-size: 250px 20px;}.headerXbox-3G-4PF:before { background: url('https://cdn.discordapp.com/attachments/787050568107556864/823059183535652884/wave_xbox.png'); background-size: 250px 20px;}@keyframes animate { 0% { background-position-x: 0;} 100% { background-position-x: 250px;}}@keyframes animate2 {0% { background-position-x: 250px; } 100% { background-position-x: 0px;}}

/* No scrollbars */
::-webkit-scrollbar { display: none !important;}.note-3HfJZ5 { margin-right: 0; }.content-1x5b-n { margin: 0 !important; border-radius: 0; }.mainContent-u_9PKf { padding-left: 8px;}.member-3-YXUe, [id*="private-channels-"] { margin: 0; max-width: unset; }.layout-2DM8Md { border-radius: 0; padding: 0 16px;}.unread-2lAfLh { z-index: 1;}.content-1LAB8Z, .item-1tOPte { margin-right: 8px;}.scroller-2hZ97C { padding-left: 0;}.scroller-2hZ97C > .content-3YMskv, .buttons-3JBrkn, .messagesPopout-24nkyi { padding-right: 10px !important; }.inviteRow-2L02ae {border-radius: 0; padding-left: 15px;}

/* Better Spotify plugin seek bar */
.container-6sXIoE { border-bottom: none !important; padding-top: 0 !important; margin: 0 !important;}
.container-6sXIoE .timeline-UWmgAx { position: absolute !important; left: 0px !important;width: 240px !important; height: 53px !important;margin: 0;-webkit-mask-image: linear-gradient(0.25turn, #0008, #0002) !important;mask-image: linear-gradient(0.25turn, #0008, #0002) !important;border-radius: 0 !important;}.bar-g2ZMIm .barFill-Dhkah7 { border-radius: 0 !important;}.container-6sXIoE.maximized-vv2Wr0 .bar-g2ZMIm { height: 87px !important;}.container-6sXIoE .button-14-BFJ:hover { background-color: transparent !important;}.barFill-Dhkah7, .timeline-UWmgAx:hover .barFill-Dhkah7 { background: var(--spotify-color) !important;}.inner-WRV6k5 { z-index: 1 !important;}.barText-lmqc5O, .grabber-7sd5f5 { display: none !important;}.container-6sXIoE .bar-g2ZMIm { width: 100% !important; height: 100% !important; margin-bottom: 0 !important;}

/*8.c. Attachments*/

.wrapper-2TxpI8 {
	background:transparent !important;
}

.imageWrapper-2p5ogY {
	box-shadow: 0 3px 7px rgba(0, 0, 0, 0.4);
    transition: 200ms cubic-bezier(0.2, 0, 0, 1) !important;
    background: rgba(255,255,255,0.075);
	border-radius: 0;
}

.full-motion {
	backdrop-filter:blur(10px);
}

.imageWrapper-2p5ogY:hover {
	box-shadow: 0 5px 15px rgba(0, 0, 0, 0.5);
}

.embedImage-2W1cML img {
	border-radius:0;
}

.attachment-33OFj0 {
	border-radius: 0;
	box-shadow: 0 4px 15px var(--background-secondary), inset 0 0 1000px rgba(255, 255, 255, .1) !important;
	padding: 15px;
	max-width: 375px;
	border: none !important;
	background: var(--background-tertiary) !important;
	position: relative;
	overflow:hidden;
}

.attachmentInner-3vEpKt::before {
	content: '';
	display: flex;
	position: absolute;
	top:50%;
	transform:translateY(-50%);
	left:0;
	margin-left:10px;
	width: 50px;
	height: 50px;
	background:rgba(255, 255, 255, .05) url(data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPCEtLSBHZW5lcmF0b3I6IEFkb2JlIElsbHVzdHJhdG9yIDE5LjAuMCwgU1ZHIEV4cG9ydCBQbHVnLUluIC4gU1ZHIFZlcnNpb246IDYuMDAgQnVpbGQgMCkgIC0tPgo8c3ZnIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHg9IjBweCIgeT0iMHB4IiB2aWV3Qm94PSIwIDAgOTYgOTYiIHN0eWxlPSJlbmFibGUtYmFja2dyb3VuZDpuZXcgMCAwIDk2IDk2OyIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSIgZmlsbD0iI2ZmZmZmZiI+CjxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+Cgkuc3Qwe2ZpbGw6ICNmZmZmZmY7fQo8L3N0eWxlPgo8ZyBpZD0iWE1MSURfNV8iPgoJPHBhdGggaWQ9IlhNTElEXzlfIiBjbGFzcz0ic3QwIiBkPSJNMzkuMyw2MS4xaDE3LjVWNDMuNmgxMS43TDQ4LDIzLjJMMjcuNiw0My42aDExLjdWNjEuMXogTTI3LjYsNjdoNDAuOHY1LjhIMjcuNlY2N3oiLz4KPC9nPgo8L3N2Zz4K) center/70% no-repeat;
}

.attachmentInner-3vEpKt {
	overflow: visible;
	padding-left:60px;
	width:100%;
	box-sizing:border-box;
}

.icon-1kp3fr {
	display: none;
}

.metadata-3WGS0M {
	color: #fff;
	text-shadow: 0 0 12px;
	margin-top: 5px;
}

.metadata-3WGS0M:before {
	content: 'File Size: ';
	color: rgba(255, 255, 255, .5);
	opacity: 1;
	text-shadow: none;
}

.filenameLinkWrapper-1-14c5 a {
	color: rgba(255, 255, 255, 1) !important;
	text-shadow: none !important;
	font-size: var(--size1);
	font-weight: 500;
	text-decoration: none !important;
}

.attachment-33OFj0 .fileNameLink-9GuxCo::after {
	content: 'Download';
	font-size: 12px;
	transition: 150ms ease;
	background: var(--blurple);
	box-shadow: 0 0 12px var(--blurple);
	position: absolute;
	padding: 7px 10px;
	bottom: 10px;
	right: 10px;
}

.attachment-33OFj0 .fileNameLink-9GuxCo:hover::after {
	box-shadow: 0 0 12px var(--blurple);
	background: var(--blurple);
}

.downloadButton-23tKQp {
	display: none;
}

.filenameLinkWrapper-1-14c5 {
	max-width:180px;
	overflow:hidden;
	color: rgba(255, 255, 255, 1) !important;
}

.progressContainer-3ao-eu::before {
	display:none;
}

.filename-3eBB_v {
	max-width:180px;
	color: rgba(255, 255, 255, 1) !important;
	text-shadow: none !important;
	font-size: var(--size1);
	font-weight: 500;
	text-decoration: none !important;
}

.cancelButton-3hVEV6 {
	position:relative;
}

.size-1Arx_I {
	position:static;
}

.small-1CUeBa,
.xsmall-3czJwD {
	border-radius:0;
	height:4px;
}

.attachment-33OFj0 .progress-3Rbvu0 {
	background:rgba(255,255,255,0.07) !important;
}

.attachment-33OFj0 .small-1CUeBa[style*="rgb(114, 137, 218)"] {
	background:var(--blurple) !important;
}

.metadataName-14STf- {
	font-size:var(--size1);
}

.metadataSize-2UOOLK {
	font-size:var(--size3);
}

.durationTimeDisplay-jww5fr, .durationTimeSeparator-2_xpJ7 {
	font-size:var(--size3);
	font-family:var(--font);
}

.fakeEdges-27pgtp:before,
.fakeEdges-27pgtp:after {
	border-radius:0;
}
.

/*8.d. Embeds, Invites and Gifts*/

.embedFull-2tM8-- {
	border-color: var(--hover);
}

.artwork-1vrmJ_,
.embedImage-2W1cML img, .embedImage-2W1cML video,
.embedThumbnail-2Y84-K img,
.embedThumbnail-2Y84-K video,
.embedVideo-3nf0O9 img,
.embedVideo-3nf0O9 video {
	border-radius:0;
}

.embedFull-2tM8--,
.markup-2BOw-j code.inline,
.wrapper-35wsBm,
#app-mount .invite-18yqGF {
	box-shadow: 0 2px 4px rgba(0, 0, 0, .35);
	background-color: rgba(0, 0, 0, .45);
	backdrop-filter: blur(10px);
	border-left-width: 2px;
	border-radius: 0;
	box-sizing: border-box;
	position: relative;
	overflow: hidden;
}

#app-mount .invite-18yqGF {
	border: none;
}

.guildDetail-1nRKNE {
	font-size:var(--size2);
}

.partyAvatar-34PPpo {
	margin-right: 10px;
}

#app-mount .chat-3bRxxu .invite-18yqGF .wrapper-3t9DeA,
.partyMemberEmpty-2iyh5g,
.moreUsers-1sZP3U {
	height: 24px !important;
	width: 24px !important;
	border-radius: var(--user-roundness) !important;
}

.avatarMasked-3y6o4j {
	mask: none !important;
	-webkit-mask: none !important;
}

#app-mount .wrapper-35wsBm .guildIconImage-3qTk45 {
	margin-right: 15px !important;
	display: block;
}

.partyMemberEmpty-2iyh5g,
.moreUsers-1sZP3U {
	background: rgba(255, 255, 255, 0.075) !important;
}

.helpIcon-2EyVTp {
	background: rgba(255, 255, 255, 0.075) !important;
	border-radius: 0;
	padding: 4px;
}

.wrapper-35wsBm .lookFilled-1Gx00P.colorGreen-29iAKY {
	box-shadow: none;
}

.wrapper-35wsBm .guildIconImage-3qTk45 {
	overflow: visible;
	position: initial;
}

.partyStatus-6AjDud {
	padding: 0;
}

#app-mount .header-Hg_qNF {
	font-weight: 600;
	color: rgba(255, 255, 255, 0.75);
	font-size:var(--size1);
	text-transform:none;
}

.partyStatus-6AjDud,
.details-3NqflA,
.state-2dqgON {
	font-size:var(--size2);
	line-height:normal;
}

.wrapper-35wsBm .guildIconImage-3qTk45::after {
	content: '';
	background-image: inherit;
	position: absolute;
	top: 0;
	left: 0;
	width: 100%;
	height: 100%;
	z-index: -1;
	opacity: .1;
	filter: blur(15px);
	background-size: 100%;
	background-position: center;
	transition: transform 150ms ease;
}

.wrapper-35wsBm:hover .guildIconImage-3qTk45::after {
	transform: scale(1.15);
}

.guildIconExpired-2Qcq05 {
	display: none;
}

.embedFull-2tM8--[style*="rgb(114, 137, 218)"] {
	border-color: var(--hover) !important;
}

.embedAuthorIcon--1zR3L {
	border-radius:var(--user-roundness);
}

.embedTitle-3OXDkz {
	font-size:var(--size1);
}

.gifTag-31zFY8 {
	border-radius:2px;
	background:var(--lv1);
	display:flex;
	justify-content:center;
	align-items:center;
	box-shadow:0 2px 6px var(--lv1);
}

.gifTag-31zFY8::after {
	content:'GIF';
	color:#fff;
	font-size:var(--size2);
}

.
`;
if (typeof GM_addStyle !== "undefined") {
  GM_addStyle(css);
} else {
  let styleNode = document.createElement("style");
  styleNode.appendChild(document.createTextNode(css));
  (document.querySelector("head") || document.documentElement).appendChild(styleNode);
}
})();