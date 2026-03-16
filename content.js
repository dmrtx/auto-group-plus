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

    // Create Toast UI
    const toast = document.createElement('div');
    toast.className = 'toast';

    toast.innerHTML = `
    <div class="toast-header">
      <div class="spinner-track"></div>
      <div class="toast-message">
        Moving to group <strong>"${groupName}"</strong> in <span id="timer">${seconds}</span>s...
      </div>
    </div>
    <div class="toast-actions">
      <button class="btn btn-cancel" id="btn-cancel">Cancel</button>
      <button class="btn btn-primary" id="btn-move">Move Now</button>
    </div>
  `;

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
