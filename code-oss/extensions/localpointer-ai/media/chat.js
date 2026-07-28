/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const modelEl = document.getElementById('model');
  const messagesEl = document.getElementById('messages');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const refreshBtn = document.getElementById('refresh');
  const clearBtn = document.getElementById('clear');
  const agentEl = document.getElementById('agent');
  const runEverythingEl = document.getElementById('runEverything');
  const approvalModeWrap = document.getElementById('approvalModeWrap');
  const whyEl = document.getElementById('why');
  const whyPanel = document.getElementById('whyPanel');
  const statusEl = document.getElementById('status');
  const workingBanner = document.getElementById('workingBanner');
  const workingLabel = document.getElementById('workingLabel');
  const workingElapsed = document.getElementById('workingElapsed');
  const inputRow = document.getElementById('inputRow');
  const hintEl = document.getElementById('hint');

  let streaming = false;
  let streamBuf = '';
  let gotToken = false;
  let workStartedAt = 0;
  let workTimer = null;
  let pendingText = '';

  function syncApprovalModeVisibility() {
    if (!approvalModeWrap) {
      return;
    }
    approvalModeWrap.classList.toggle('hidden', !agentEl.checked);
    if (runEverythingEl) {
      runEverythingEl.disabled = !agentEl.checked;
    }
  }

  function setRunEverythingChecked(on) {
    if (runEverythingEl) {
      runEverythingEl.value = on ? 'allowAll' : 'ask';
    }
  }

  function showApprovalCard(msg) {
    const existing = document.getElementById('approval-' + msg.id);
    if (existing) {
      existing.remove();
    }
    const card = document.createElement('div');
    card.className = 'approval-card';
    card.id = 'approval-' + msg.id;
    const argsText = msg.args && Object.keys(msg.args).length
      ? JSON.stringify(msg.args, null, 2)
      : '';
    card.innerHTML =
      '<div class="approval-title">Allow tool <code>' + escapeHtml(msg.tool || 'tool') + '</code>?</div>' +
      (argsText ? '<pre class="approval-args">' + escapeHtml(argsText) + '</pre>' : '') +
      '<div class="approval-actions">' +
      '<button type="button" class="allow" data-action="allow">Allow</button>' +
      '<button type="button" class="secondary deny" data-action="deny">Deny</button>' +
      '<button type="button" class="secondary run-all" data-action="runAll">Run all</button>' +
      '</div>';
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.getAttribute('data-action');
        const allow = action === 'allow' || action === 'runAll';
        const runAll = action === 'runAll';
        vscode.postMessage({ type: 'approve', id: msg.id, allow: allow, runAll: runAll });
        card.classList.add('resolved');
        const label = runAll ? 'Allowed · Run everything on' : allow ? 'Allowed' : 'Denied';
        card.querySelector('.approval-actions').innerHTML =
          '<span class="approval-result">' + label + '</span>';
        if (runAll) {
          setRunEverythingChecked(true);
        }
      });
    });
    messagesEl.appendChild(card);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    setStatus('Waiting for tool approval\u2026');
  }

  function ensureToolActivitySection() {
    let section = document.getElementById('toolActivity');
    if (section) {
      return section;
    }
    section = document.createElement('details');
    section.className = 'tool-activity';
    section.id = 'toolActivity';
    // Collapsed by default — do not set open.
    section.innerHTML =
      '<summary class="tool-activity-summary">Tools</summary>' +
      '<div class="tool-activity-body" id="toolActivityBody"></div>';
    const stream = document.getElementById('stream');
    const streamBody = document.getElementById('streamBody');
    if (stream && streamBody) {
      stream.insertBefore(section, streamBody);
    } else if (stream) {
      stream.appendChild(section);
    } else {
      messagesEl.appendChild(section);
    }
    return section;
  }

  function appendToolActivity(msg) {
    const section = ensureToolActivitySection();
    const summary = section.querySelector('.tool-activity-summary');
    if (summary) {
      summary.textContent = msg.summary || 'Tools';
    }
    const body = document.getElementById('toolActivityBody');
    if (!body) {
      return;
    }
    const block = document.createElement('div');
    block.className = 'tool-activity-entry';
    block.textContent = String(msg.text || '').replace(/\n+$/, '');
    body.appendChild(block);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function finalizeToolActivitySection() {
    const section = document.getElementById('toolActivity');
    if (section) {
      section.removeAttribute('id');
    }
    const body = document.getElementById('toolActivityBody');
    if (body) {
      body.removeAttribute('id');
    }
  }

  function resolveApprovalCard(id) {
    const card = document.getElementById('approval-' + id);
    if (card && !card.classList.contains('resolved')) {
      card.classList.add('resolved');
      const actions = card.querySelector('.approval-actions');
      if (actions) {
        actions.innerHTML = '<span class="approval-result">Resolved</span>';
      }
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('error', !!isError);
  }

  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) {
      return s + 's';
    }
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + 'm ' + r + 's';
  }

  function stopWorkTimer() {
    if (workTimer) {
      clearInterval(workTimer);
      workTimer = null;
    }
  }

  function startWorkTimer(modelName) {
    stopWorkTimer();
    workStartedAt = Date.now();
    workingLabel.textContent = modelName
      ? ('Waiting on ' + modelName + '\u2026')
      : 'Model is working\u2026';
    workingElapsed.textContent = '0s';
    workingBanner.classList.add('visible');
    inputRow.classList.add('working');
    hintEl.textContent = 'Local model is generating a reply\u2026';
    workTimer = setInterval(() => {
      const elapsed = Date.now() - workStartedAt;
      workingElapsed.textContent = formatElapsed(elapsed);
      if (!gotToken && elapsed >= 3000) {
        workingLabel.textContent = modelName
          ? (modelName + ' is still thinking\u2026')
          : 'Still thinking\u2026';
      }
    }, 250);
  }

  function renderMessages(msgs) {
    messagesEl.innerHTML = '';
    if (!msgs || !msgs.length) {
      messagesEl.innerHTML =
        '<div class="empty">Ask anything \u2014 replies come from your local Ollama model.</div>';
      return;
    }
    for (const m of msgs) {
      const div = document.createElement('div');
      const isErr = m.role === 'assistant' && String(m.content).startsWith('Error:');
      div.className = 'msg ' + m.role + (isErr ? ' error' : '');
      div.innerHTML =
        '<div class="role">' + escapeHtml(m.role) + '</div>';
      if (m.activity && Array.isArray(m.activity.entries) && m.activity.entries.length) {
        const details = document.createElement('details');
        details.className = 'tool-activity';
        const summary = document.createElement('summary');
        summary.className = 'tool-activity-summary';
        summary.textContent = m.activity.summary || 'Activity';
        const activityBody = document.createElement('div');
        activityBody.className = 'tool-activity-body';
        for (const entry of m.activity.entries) {
          const block = document.createElement('div');
          block.className = 'tool-activity-entry';
          block.textContent = String(entry).replace(/\n+$/, '');
          activityBody.appendChild(block);
        }
        details.appendChild(summary);
        details.appendChild(activityBody);
        div.appendChild(details);
      }
      const content = document.createElement('div');
      content.className = 'message-content';
      content.textContent = m.content;
      div.appendChild(content);
      messagesEl.appendChild(div);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function fillModels(models, selected) {
    const list = Array.isArray(models) ? models : [];
    if (!list.length) {
      modelEl.innerHTML = '<option value="">No models \u2014 ollama pull \u2026</option>';
      modelEl.disabled = true;
      sendBtn.disabled = true;
      return;
    }
    modelEl.disabled = streaming;
    sendBtn.disabled = streaming;
    modelEl.innerHTML = list
      .map(
        (m) =>
          '<option value="' +
          escapeHtml(m) +
          '"' +
          (m === selected ? ' selected' : '') +
          '>' +
          escapeHtml(m) +
          '</option>',
      )
      .join('');
    if (selected && list.includes(selected)) {
      modelEl.value = selected;
    } else if (!modelEl.value && list.length) {
      modelEl.value = list[0];
    }
  }

  function setStreaming(active, modelName) {
    streaming = active;
    sendBtn.disabled = active || !modelEl.value;
    inputEl.disabled = active;
    modelEl.disabled = active || modelEl.options.length === 0 || !modelEl.value;
    if (active) {
      streamBuf = '';
      gotToken = false;
      const empty = messagesEl.querySelector('.empty');
      if (empty) {
        empty.remove();
      }
      const div = document.createElement('div');
      div.className = 'msg assistant pending';
      div.id = 'stream';
      div.innerHTML =
        '<div class="role">assistant</div>' +
        '<div class="thinking" id="thinking">' +
        '<span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span>' +
        '<span>Waiting for ' +
        escapeHtml(modelName || 'model') +
        '</span>' +
        '</div>' +
        '<span id="streamBody" class="cursor-blink"></span>';
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      startWorkTimer(modelName || modelEl.value || '');
      setStatus('Generating with ' + (modelName || modelEl.value || 'model') + '\u2026');
    } else {
      stopWorkTimer();
      workingBanner.classList.remove('visible');
      inputRow.classList.remove('working');
      hintEl.textContent = 'Enter to send \u00b7 Ctrl+Enter or Shift+Enter for newline';
      const stream = document.getElementById('stream');
      if (stream) {
        stream.classList.remove('pending');
        stream.removeAttribute('id');
      }
      const body = document.getElementById('streamBody');
      if (body) {
        body.classList.remove('cursor-blink');
      }
      const thinking = document.getElementById('thinking');
      if (thinking) {
        thinking.remove();
      }
      finalizeToolActivitySection();
      pendingText = '';
    }
  }

  function doSend() {
    if (streaming) {
      setStatus('Still waiting on the model\u2026', false);
      return;
    }
    const text = inputEl.value.trim();
    if (!text) {
      setStatus('Type a message first', true);
      return;
    }
    if (!modelEl.value) {
      setStatus('Select an Ollama model first (Refresh if the list is empty)', true);
      return;
    }
    pendingText = text;
    setStatus('Sending\u2026');
    vscode.postMessage({ type: 'send', text: text, model: modelEl.value });
  }

  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    doSend();
  });
  refreshBtn.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
  clearBtn.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

  // Enter = send; Shift+Enter = newline. Ctrl/Cmd+Enter also inserts a newline.
  inputEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.keyCode !== 13) {
      return;
    }
    if (e.isComposing || e.keyCode === 229) {
      return;
    }
    if (e.shiftKey) {
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const start = inputEl.selectionStart;
      const end = inputEl.selectionEnd;
      const v = inputEl.value;
      const nl = '\n';
      inputEl.value = v.slice(0, start) + nl + v.slice(end);
      inputEl.selectionStart = inputEl.selectionEnd = start + 1;
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    doSend();
  });

  modelEl.addEventListener('change', () => {
    vscode.postMessage({ type: 'selectModel', model: modelEl.value });
    sendBtn.disabled = streaming || !modelEl.value;
  });

  agentEl.addEventListener('change', () => {
    syncApprovalModeVisibility();
    vscode.postMessage({ type: 'toggleAgent', enabled: agentEl.checked });
  });

  if (runEverythingEl) {
    runEverythingEl.addEventListener('change', () => {
      vscode.postMessage({
        type: 'setApprovalMode',
        mode: runEverythingEl.value === 'allowAll' ? 'allowAll' : 'ask',
      });
    });
  }

  whyEl.addEventListener('change', () => {
    whyPanel.classList.toggle('visible', whyEl.checked);
    vscode.postMessage({ type: 'toggleWhy', enabled: whyEl.checked });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'init':
        fillModels(msg.models, msg.model);
        agentEl.checked = !!msg.agentMode;
        setRunEverythingChecked(msg.approvalMode === 'allowAll');
        syncApprovalModeVisibility();
        whyEl.checked = !!msg.showWhy;
        whyPanel.classList.toggle('visible', !!msg.showWhy);
        renderMessages(msg.messages || []);
        if (msg.error) {
          setStatus(msg.error, true);
        } else if (!msg.ollamaOk) {
          setStatus('Ollama unreachable at ' + (msg.ollamaUrl || ''), true);
        }
        break;
      case 'sendAccepted':
        if (pendingText && inputEl.value.trim() === pendingText) {
          inputEl.value = '';
        } else if (pendingText) {
          // Clear only the sent text if the user kept typing
          const cur = inputEl.value;
          if (cur.trimStart().startsWith(pendingText)) {
            inputEl.value = cur.trimStart().slice(pendingText.length).replace(/^\n/, '');
          } else {
            inputEl.value = '';
          }
        }
        pendingText = '';
        break;
      case 'sendRejected':
        pendingText = '';
        setStatus(msg.reason || 'Could not send', true);
        setStreaming(false);
        break;
      case 'messages':
        renderMessages(msg.messages || []);
        break;
      case 'streaming':
        setStreaming(!!msg.active, msg.model || modelEl.value || '');
        break;
      case 'streamToken':
        if (!gotToken) {
          gotToken = true;
          const thinking = document.getElementById('thinking');
          if (thinking) {
            thinking.remove();
          }
          const streamMsg = document.getElementById('stream');
          if (streamMsg) {
            streamMsg.classList.remove('pending');
          }
          workingLabel.textContent = 'Streaming response\u2026';
        }
        streamBuf += msg.token || '';
        const body = document.getElementById('streamBody');
        if (body) {
          body.textContent = streamBuf;
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      case 'model':
        if (msg.model) {
          modelEl.value = msg.model;
        }
        break;
      case 'why':
        whyPanel.textContent = msg.info ? JSON.stringify(msg.info, null, 2) : '';
        break;
      case 'status':
        setStatus(msg.text || '', /error/i.test(msg.text || ''));
        break;
      case 'approval':
        showApprovalCard(msg);
        break;
      case 'approvalResolved':
        resolveApprovalCard(msg.id);
        break;
      case 'approvalMode':
        setRunEverythingChecked(msg.mode === 'allowAll');
        break;
      case 'toolActivity':
        appendToolActivity(msg);
        break;
      case 'reset':
        setStreaming(false);
        setStatus(msg.text || 'Ready');
        break;
    }
  });

  syncApprovalModeVisibility();
  vscode.postMessage({ type: 'ready' });
})();
