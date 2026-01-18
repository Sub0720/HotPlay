document.addEventListener('DOMContentLoaded', async () => {
    const STORAGE_KEY = 'vcConfig';
    const container = document.getElementById('shortcuts-container');
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    
    // Default config structure
    let config = data[STORAGE_KEY] || {
        shortcuts: { 
            volUp: 'ArrowUp', volDown: 'ArrowDown', 
            playPause: 'k', speedUp: '>', speedDown: '<', 
            mute: 'm', seekBack: 'j', seekFwd: 'l', seekBack5: 'ArrowLeft', seekFwd5: 'ArrowRight'
        },
        settings: { speed: 1.0, volume: 40 }
    };

    // Dictionary for pretty names
    const prettyNames = {
        volUp: "Volume Up", volDown: "Volume Down", playPause: "Play/Pause",
        speedUp: "Speed Up", speedDown: "Speed Down", mute: "Mute",
        seekBack: "Seek -10s", seekFwd: "Seek +10s", seekBack5: "Seek -5s", seekFwd5: "Seek +5s"
    };

    function render() {
        container.innerHTML = '';
        for (const [action, key] of Object.entries(config.shortcuts)) {
            const div = document.createElement('div');
            div.className = 'setting';
            div.innerHTML = `
                <span class="label">${prettyNames[action] || action}</span>
                <input type="text" id="${action}" value="${key}">
            `;
            container.appendChild(div);
        }
    }
    
    render();

    // Toggle Add Section
    const addSection = document.getElementById('add-section');
    document.getElementById('add-btn').addEventListener('click', () => {
        addSection.style.display = addSection.style.display === 'block' ? 'none' : 'block';
    });

    // Confirm Add
    document.getElementById('confirm-add').addEventListener('click', () => {
        const name = document.getElementById('new-action-name').value;
        const key = document.getElementById('new-action-key').value;
        
        if(name && key) {
            // Sanitize name for ID
            const safeId = name.replace(/\s+/g, '');
            config.shortcuts[safeId] = key;
            render();
            addSection.style.display = 'none';
        }
    });

    // Save
    document.getElementById('save').addEventListener('click', () => {
        const inputs = container.querySelectorAll('input:not(#new-action-name):not(#new-action-key)');
        inputs.forEach(input => {
            config.shortcuts[input.id] = input.value;
        });
        
        chrome.storage.local.set({ [STORAGE_KEY]: config }, () => {
            const btn = document.getElementById('save');
            const originalText = btn.innerText;
            btn.innerText = "Saved!";
            btn.style.background = "#00cc00";
            setTimeout(() => { 
                btn.innerText = originalText; 
                btn.style.background = "#cc0000";
            }, 1000);
        });
    });
});
