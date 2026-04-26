// Listen for messages from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'SHOW_COUNTDOWN') {
        showCountdown(request.groupName, request.seconds || 5);
    }
});

let toastHost = null;
let timerInterval = null;

function showCountdown(groupName, seconds) {
    // Remove existing if any
    if (toastHost) removeToast();

    // Create Shadow DOM host
    toastHost = document.createElement('div');
    toastHost.id = 'auto-group-toast-host';
    const shadow = toastHost.attachShadow({ mode: 'open' });

    // Load CSS
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = chrome.runtime.getURL('content.css');
    shadow.appendChild(style);

    const toast = buildToast(groupName, seconds);

    shadow.appendChild(toast);
    document.body.appendChild(toastHost);

    // Event Listeners
    const btnCancel = shadow.getElementById('btn-cancel');
    const btnMove = shadow.getElementById('btn-move');
    const timerSpan = shadow.getElementById('timer');

    let remaining = seconds;

    timerInterval = setInterval(() => {
        remaining--;
        if (timerSpan) timerSpan.innerText = remaining;

        if (remaining <= 0) {
            clearInterval(timerInterval);
            // Let background handle the timeout act, but we can cleanup UI
            removeToast();
        }
    }, 1000);

    btnCancel.onclick = () => {
        clearInterval(timerInterval);
        chrome.runtime.sendMessage({ action: 'CANCEL_MERGE' });
        removeToast();
    };

    btnMove.onclick = () => {
        clearInterval(timerInterval);
        chrome.runtime.sendMessage({ action: 'CONFIRM_MERGE' });
        removeToast();
    };
}

function buildToast(groupName, seconds) {
    const toast = document.createElement('div');
    toast.className = 'toast';

    const header = document.createElement('div');
    header.className = 'toast-header';

    const spinner = document.createElement('div');
    spinner.className = 'spinner-track';

    const message = document.createElement('div');
    message.className = 'toast-message';
    message.append('Moving to group ');

    const strong = document.createElement('strong');
    strong.textContent = `"${groupName}"`;
    message.append(strong, ' in ');

    const timer = document.createElement('span');
    timer.id = 'timer';
    timer.textContent = String(seconds);
    message.append(timer, 's...');

    header.append(spinner, message);

    const actions = document.createElement('div');
    actions.className = 'toast-actions';

    const cancel = document.createElement('button');
    cancel.className = 'btn btn-cancel';
    cancel.id = 'btn-cancel';
    cancel.textContent = 'Cancel';

    const move = document.createElement('button');
    move.className = 'btn btn-primary';
    move.id = 'btn-move';
    move.textContent = 'Move Now';

    actions.append(cancel, move);
    toast.append(header, actions);

    return toast;
}

function removeToast() {
    if (toastHost) {
        toastHost.remove();
        toastHost = null;
    }
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}
