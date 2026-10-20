(function() {
  var schema = null;
  var draftConfig = {};
  var appliedConfig = null;
  var ws = null;
  var mediaStream = null;
  var audioContext = null;
  var scriptNode = null;
  var sourceNode = null;
  var pcmBuffer = [];
  var sendInterval = null;
  var currentState = 'idle';
  var currentVolume = 0;
  var errorTimeout = null;
  var stats = {
    clientWsConnected: false,
    doubaoStatus: 'disconnected',
    logid: '',
    firstPacketLatency: null,
    lastLatency: null,
    audioDurationMs: 0,
    lastError: '',
    events: [],
    firstAudioSentAt: 0,
    lastSendAt: 0,
    firstResultReceived: false
  };
  var finalizedUtterances = [];
  var partialText = '';
  var recordingStartAt = 0;

  var micBtn = null;
  var statusText = null;
  var statusDot = null;
  var volumeBar = null;
  var resultArea = null;
  var errorArea = null;
  var configForm = null;
  var applyBtn = null;
  var resetBtn = null;
  var configHint = null;
  var configWarning = null;
  var warningBanner = null;
  var connectionStatus = null;
  var metricsStatus = null;
  var appliedConfigDisplay = null;
  var eventLog = null;
  var errorSection = null;
  var errorBox = null;
  var attendeesBtn = null;
  var attendeesModal = null;
  var modalCloseBtn = null;
  var modalCancelBtn = null;
  var modalSaveBtn = null;
  var addRowBtn = null;
  var attendeeRowsEl = null;
  var modalCountEl = null;
  var attendeeList = [];
  var savedAttendees = [];
  var voiceprintEnabled = false;
  var speakerBindings = {};
  var summaryBtn = null;
  var clearSummariesBtn = null;
  var importBtn = null;
  var summaryList = null;
  var summaryHint = null;
  var summaryItems = [];
  var lastTranscript = '';
  var lastTurns = [];
  var lastDurationMs = 0;
  var summaryBusy = false;
  var llmConfigured = false;
  var importModal = null;
  var importModalCloseBtn = null;
  var importModalCancelBtn = null;
  var importGenerateBtn = null;
  var importFileBtn = null;
  var importFileInput = null;
  var importTextArea = null;
  var importFileName = null;
  var importCharCount = null;

  function addEvent(text) {
    var now = new Date();
    var timeStr = now.toTimeString().slice(0, 8);
    stats.events.push({ time: timeStr, text: text });
    if (stats.events.length > 20) {
      stats.events = stats.events.slice(stats.events.length - 20);
    }
    renderEventLog();
  }

  function renderEventLog() {
    if (!eventLog) return;
    eventLog.innerHTML = '';
    for (var i = 0; i < stats.events.length; i++) {
      var ev = stats.events[i];
      var line = document.createElement('div');
      line.className = 'event-line';
      var timeSpan = document.createElement('span');
      timeSpan.className = 'event-time';
      timeSpan.textContent = ev.time;
      line.appendChild(timeSpan);
      var textSpan = document.createElement('span');
      textSpan.textContent = ev.text;
      line.appendChild(textSpan);
      eventLog.appendChild(line);
    }
    eventLog.scrollTop = eventLog.scrollHeight;
  }

  function getBasePath() {
    var p = location.pathname;
    if (p.endsWith('/')) return p;
    var idx = p.lastIndexOf('/');
    return idx >= 0 ? p.substring(0, idx + 1) : '/';
  }

  function parseHotwordsInput() {
    var el = document.getElementById('hotwordsInput');
    if (!el) return [];
    var text = (el.value || '').trim();
    if (!text) return [];
    return text.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
  }

  function parseCorrectWordsInput() {
    var el = document.getElementById('correctWordsInput');
    if (!el) return null;
    var text = (el.value || '').trim();
    if (!text) return null;
    var result = {};
    var hasAny = false;
    text.split('\n').forEach(function(line) {
      var idx = line.indexOf('=');
      if (idx > 0) {
        var k = line.substring(0, idx).trim();
        var v = line.substring(idx + 1).trim();
        if (k && v) { result[k] = v; hasAny = true; }
      }
    });
    return hasAny ? result : null;
  }

  var HOTWORD_MAX = 100;
  var CORRECT_WORD_MAX = 100;

  function updateHotwordCounter() {
    var input = document.getElementById('hotwordsInput');
    var counter = document.getElementById('hotwordsCounter');
    if (!input || !counter) return;
    var words = parseHotwordsInput();
    var count = words.length;
    counter.textContent = count + '/' + HOTWORD_MAX;
    var over = count > HOTWORD_MAX;
    counter.classList.toggle('over-limit', over);
    input.classList.toggle('over-limit', over);
  }

  function updateCorrectWordCounter() {
    var input = document.getElementById('correctWordsInput');
    var counter = document.getElementById('correctWordsCounter');
    if (!input || !counter) return;
    var cw = parseCorrectWordsInput();
    var count = cw ? Object.keys(cw).length : 0;
    counter.textContent = count + '/' + CORRECT_WORD_MAX;
    var over = count > CORRECT_WORD_MAX;
    counter.classList.toggle('over-limit', over);
    input.classList.toggle('over-limit', over);
  }

  function initHotwordCounters() {
    var hw = document.getElementById('hotwordsInput');
    var cw = document.getElementById('correctWordsInput');
    if (hw) {
      hw.addEventListener('input', updateHotwordCounter);
      updateHotwordCounter();
    }
    if (cw) {
      cw.addEventListener('input', updateCorrectWordCounter);
      updateCorrectWordCounter();
    }
  }

  function buildHotwordStartPayload() {
    var hwList = parseHotwordsInput();
    var cwMap = parseCorrectWordsInput();
    var truncated = false;
    if (hwList.length > HOTWORD_MAX) {
      hwList = hwList.slice(0, HOTWORD_MAX);
      truncated = true;
    }
    if (cwMap) {
      var keys = Object.keys(cwMap);
      if (keys.length > CORRECT_WORD_MAX) {
        var trimmed = {};
        keys.slice(0, CORRECT_WORD_MAX).forEach(function(k) { trimmed[k] = cwMap[k]; });
        cwMap = trimmed;
        truncated = true;
      }
    }
    return { hwList: hwList, cwMap: cwMap, truncated: truncated };
  }

  function renderStatusDot(el, color) {
    el.className = 'status-dot dot-' + color;
  }

  function renderStats() {
    if (!connectionStatus || !metricsStatus) return;

    connectionStatus.innerHTML = '';

    var wsRow = document.createElement('div');
    wsRow.className = 'kv-row';
    var wsKey = document.createElement('span');
    wsKey.className = 'kv-key';
    wsKey.textContent = 'WebSocket';
    var wsVal = document.createElement('span');
    wsVal.className = 'kv-val';
    var wsDot = document.createElement('span');
    wsDot.className = 'status-dot';
    wsDot.style.display = 'inline-block';
    wsDot.style.marginRight = '6px';
    wsDot.style.verticalAlign = 'middle';
    if (stats.clientWsConnected) {
      renderStatusDot(wsDot, 'green');
      wsVal.appendChild(wsDot);
      wsVal.appendChild(document.createTextNode('已连接'));
    } else {
      renderStatusDot(wsDot, 'grey');
      wsVal.appendChild(wsDot);
      wsVal.appendChild(document.createTextNode('未连接'));
    }
    wsRow.appendChild(wsKey);
    wsRow.appendChild(wsVal);
    connectionStatus.appendChild(wsRow);

    var dbRow = document.createElement('div');
    dbRow.className = 'kv-row';
    var dbKey = document.createElement('span');
    dbKey.className = 'kv-key';
    dbKey.textContent = '豆包ASR';
    var dbVal = document.createElement('span');
    dbVal.className = 'kv-val';
    var dbDot = document.createElement('span');
    dbDot.className = 'status-dot';
    dbDot.style.display = 'inline-block';
    dbDot.style.marginRight = '6px';
    dbDot.style.verticalAlign = 'middle';
    var dbText = '';
    var dbColor = 'grey';
    if (stats.doubaoStatus === 'disconnected') {
      dbText = '未连接';
      dbColor = 'grey';
    } else if (stats.doubaoStatus === 'connecting') {
      dbText = '连接中...';
      dbColor = 'yellow';
    } else if (stats.doubaoStatus === 'connected') {
      dbText = '已连接';
      dbColor = 'green';
    } else if (stats.doubaoStatus === 'error') {
      dbText = '错误';
      dbColor = 'red';
    }
    renderStatusDot(dbDot, dbColor);
    dbVal.appendChild(dbDot);
    dbVal.appendChild(document.createTextNode(dbText));
    dbRow.appendChild(dbKey);
    dbRow.appendChild(dbVal);
    connectionStatus.appendChild(dbRow);

    metricsStatus.innerHTML = '';

    var firstLatRow = document.createElement('div');
    firstLatRow.className = 'kv-row';
    var firstLatKey = document.createElement('span');
    firstLatKey.className = 'kv-key';
    firstLatKey.textContent = '首包延迟';
    var firstLatVal = document.createElement('span');
    firstLatVal.className = 'kv-val';
    firstLatVal.textContent = stats.firstPacketLatency != null ? stats.firstPacketLatency + 'ms' : '-';
    firstLatRow.appendChild(firstLatKey);
    firstLatRow.appendChild(firstLatVal);
    metricsStatus.appendChild(firstLatRow);

    var lastLatRow = document.createElement('div');
    lastLatRow.className = 'kv-row';
    var lastLatKey = document.createElement('span');
    lastLatKey.className = 'kv-key';
    lastLatKey.textContent = '最近响应';
    var lastLatVal = document.createElement('span');
    lastLatVal.className = 'kv-val';
    lastLatVal.textContent = stats.lastLatency != null ? stats.lastLatency + 'ms' : '-';
    lastLatRow.appendChild(lastLatKey);
    lastLatRow.appendChild(lastLatVal);
    metricsStatus.appendChild(lastLatRow);

    var durRow = document.createElement('div');
    durRow.className = 'kv-row';
    var durKey = document.createElement('span');
    durKey.className = 'kv-key';
    durKey.textContent = '音频时长';
    var durVal = document.createElement('span');
    durVal.className = 'kv-val';
    durVal.textContent = (stats.audioDurationMs / 1000).toFixed(1) + 's';
    durRow.appendChild(durKey);
    durRow.appendChild(durVal);
    metricsStatus.appendChild(durRow);

    var uttRow = document.createElement('div');
    uttRow.className = 'kv-row';
    var uttKey = document.createElement('span');
    uttKey.className = 'kv-key';
    uttKey.textContent = '句子数';
    var uttVal = document.createElement('span');
    uttVal.className = 'kv-val';
    uttVal.textContent = finalizedUtterances.length;
    uttRow.appendChild(uttKey);
    uttRow.appendChild(uttVal);
    metricsStatus.appendChild(uttRow);
  }

  function renderAppliedConfig() {
    if (!appliedConfigDisplay) return;
    appliedConfigDisplay.innerHTML = '';
    if (appliedConfig == null) {
      var ph = document.createElement('span');
      ph.className = 'placeholder';
      ph.textContent = '尚未开始录音';
      appliedConfigDisplay.appendChild(ph);
      return;
    }
    if (!schema || !schema.params) return;
    for (var i = 0; i < schema.params.length; i++) {
      var param = schema.params[i];
      var key = param.key;
      var val = appliedConfig[key];
      if (val === undefined) continue;
      var item = document.createElement('div');
      item.className = 'applied-item';
      var kSpan = document.createElement('span');
      kSpan.className = 'applied-key';
      kSpan.textContent = param.label || key;
      var vSpan = document.createElement('span');
      vSpan.className = 'applied-val';
      var displayVal = val;
      if (param.type === 'bool') {
        displayVal = val ? '开' : '关';
      } else if (param.type === 'enum' && param.options) {
        for (var oi = 0; oi < param.options.length; oi++) {
          if (param.options[oi].value === val) {
            displayVal = param.options[oi].label;
            break;
          }
        }
      }
      vSpan.textContent = String(displayVal);
      vSpan.title = String(displayVal);
      item.appendChild(kSpan);
      item.appendChild(vSpan);
      appliedConfigDisplay.appendChild(item);
    }
  }

  function diffConfigs(a, b) {
    var diff = [];
    if (!a || !b) return diff;
    var keys = {};
    for (var k in a) keys[k] = true;
    for (var k2 in b) keys[k2] = true;
    for (var key in keys) {
      if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
        diff.push(key);
      }
    }
    return diff;
  }

  function showWarning(msg) {
    if (warningBanner) {
      warningBanner.textContent = msg;
      warningBanner.hidden = false;
    }
  }

  function hideWarning() {
    if (warningBanner) {
      warningBanner.hidden = true;
    }
  }

  function disableConfigForm(disabled) {
    if (configForm) {
      if (disabled) {
        configForm.classList.add('disabled');
      } else {
        configForm.classList.remove('disabled');
      }
    }
    if (applyBtn) {
      applyBtn.disabled = disabled;
      applyBtn.textContent = disabled ? '录音中无法修改' : '应用配置';
    }
    if (resetBtn) {
      resetBtn.disabled = disabled;
    }
    updateDependsOn();
  }

  function setDirtyHint(dirty) {
    if (!configHint) return;
    if (dirty) {
      configHint.textContent = '有未应用的修改';
      configHint.classList.add('dirty');
    } else {
      configHint.textContent = '已应用 ✓';
      configHint.classList.remove('dirty');
    }
  }

  function getOptionLabel(param, value) {
    if (!param.options) return value;
    for (var i = 0; i < param.options.length; i++) {
      if (param.options[i].value === value) {
        return param.options[i].label;
      }
    }
    return value;
  }

  function createFormControl(param) {
    var group = document.createElement('div');
    group.className = 'form-group';
    group.setAttribute('data-key', param.key);

    if (param.type === 'bool') {
      group.classList.add('switch-group');
      var label = document.createElement('label');
      label.textContent = param.label;
      var switchLabel = document.createElement('label');
      switchLabel.className = 'switch';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('data-key', param.key);
      var slider = document.createElement('span');
      slider.className = 'slider';
      switchLabel.appendChild(input);
      switchLabel.appendChild(slider);
      group.appendChild(label);
      group.appendChild(switchLabel);
    } else if (param.type === 'enum') {
      var enumLabel = document.createElement('label');
      enumLabel.textContent = param.label;
      group.appendChild(enumLabel);
      var select = document.createElement('select');
      select.setAttribute('data-key', param.key);
      if (param.options) {
        for (var i = 0; i < param.options.length; i++) {
          var opt = document.createElement('option');
          opt.value = param.options[i].value;
          opt.textContent = param.options[i].label;
          select.appendChild(opt);
        }
      }
      group.appendChild(select);
    } else if (param.type === 'number') {
      var numLabel = document.createElement('label');
      numLabel.textContent = param.label;
      group.appendChild(numLabel);
      var inputWrap = document.createElement('div');
      inputWrap.style.display = 'flex';
      inputWrap.style.gap = '6px';
      inputWrap.style.alignItems = 'center';
      var useRange = (param.min != null && param.max != null && param.step != null && (param.max - param.min) <= 3000);
      var numInput;
      if (useRange) {
        numInput = document.createElement('input');
        numInput.type = 'range';
        numInput.min = param.min;
        numInput.max = param.max;
        numInput.step = param.step || 1;
      } else {
        numInput = document.createElement('input');
        numInput.type = 'number';
        if (param.min != null) numInput.min = param.min;
        if (param.max != null) numInput.max = param.max;
        if (param.step != null) numInput.step = param.step;
      }
      numInput.setAttribute('data-key', param.key);
      inputWrap.appendChild(numInput);
      if (useRange) {
        var rvSpan = document.createElement('span');
        rvSpan.className = 'range-value';
        rvSpan.id = 'rv_' + param.key;
        rvSpan.textContent = String(param.default);
        inputWrap.appendChild(rvSpan);
      }
      group.appendChild(inputWrap);
    }

    if (param.hint) {
      var hint = document.createElement('div');
      hint.className = 'form-hint';
      hint.textContent = param.hint;
      group.appendChild(hint);
    }

    var allInputs = group.querySelectorAll('input, select');
    for (var i = 0; i < allInputs.length; i++) {
      allInputs[i].addEventListener('input', onFormChange);
      allInputs[i].addEventListener('change', onFormChange);
    }

    return group;
  }

  function updateDependsOn() {
    if (!schema || !schema.params) return;
    var formGroups = configForm.querySelectorAll('.form-group');
    var groupMap = {};
    for (var gi = 0; gi < formGroups.length; gi++) {
      var key = formGroups[gi].getAttribute('data-key');
      if (key) groupMap[key] = formGroups[gi];
    }
    for (var pi = 0; pi < schema.params.length; pi++) {
      var param = schema.params[pi];
      var grp = groupMap[param.key];
      if (!grp) continue;
      var disabled = false;
      if (param.dependsOn) {
        var depKey = param.dependsOn.key;
        var depVal = param.dependsOn.value;
        if (draftConfig[depKey] !== depVal) {
          disabled = true;
        }
      }
      if (disabled) {
        grp.classList.add('disabled');
      } else {
        grp.classList.remove('disabled');
      }
    }
  }

  function renderForm() {
    if (!configForm || !schema) return;
    configForm.innerHTML = '';

    var groupMap = {};
    var groupOrder = [];
    if (schema.groups) {
      for (var gi = 0; gi < schema.groups.length; gi++) {
        var g = schema.groups[gi];
        groupMap[g.id] = [];
        groupOrder.push(g.id);
      }
    }
    var ungrouped = [];
    for (var pi = 0; pi < schema.params.length; pi++) {
      var p = schema.params[pi];
      if (p.group && groupMap[p.group]) {
        groupMap[p.group].push(p);
      } else {
        ungrouped.push(p);
      }
    }

    for (var goi = 0; goi < groupOrder.length; goi++) {
      var gid = groupOrder[goi];
      var gParams = groupMap[gid];
      var gLabel = null;
      for (var gli = 0; gli < schema.groups.length; gli++) {
        if (schema.groups[gli].id === gid) {
          gLabel = schema.groups[gli].label;
          break;
        }
      }
      if (gLabel) {
        var gTitle = document.createElement('div');
        gTitle.className = 'section-title';
        gTitle.style.marginTop = '12px';
        gTitle.style.marginBottom = '8px';
        gTitle.textContent = gLabel;
        configForm.appendChild(gTitle);
      }
      for (var gpi = 0; gpi < gParams.length; gpi++) {
        configForm.appendChild(createFormControl(gParams[gpi]));
      }
    }

    if (ungrouped.length > 0) {
      for (var ui = 0; ui < ungrouped.length; ui++) {
        configForm.appendChild(createFormControl(ungrouped[ui]));
      }
    }
  }

  function applyFormToDraft() {
    if (!configForm) return;
    var inputs = configForm.querySelectorAll('input, select');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var key = el.getAttribute('data-key');
      if (!key) continue;
      var val;
      if (el.type === 'checkbox') {
        val = el.checked;
      } else if (el.tagName === 'SELECT') {
        val = el.value;
      } else if (el.type === 'number' || el.type === 'range') {
        val = Number(el.value);
        var rvEl = document.getElementById('rv_' + key);
        if (rvEl) {
          rvEl.textContent = String(val);
        }
      } else {
        val = el.value;
      }
      draftConfig[key] = val;
    }
  }

  function draftToForm() {
    if (!configForm || !schema) return;
    var inputs = configForm.querySelectorAll('input, select');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var key = el.getAttribute('data-key');
      if (!key) continue;
      var val = draftConfig[key];
      if (val === undefined) val = schema.defaults[key];
      if (val === undefined) continue;
      if (el.type === 'checkbox') {
        el.checked = !!val;
      } else if (el.tagName === 'SELECT') {
        el.value = val;
      } else if (el.type === 'number' || el.type === 'range') {
        el.value = String(val);
        var rvEl = document.getElementById('rv_' + key);
        if (rvEl) {
          rvEl.textContent = String(val);
        }
      } else {
        el.value = val;
      }
    }
  }

  function onFormChange() {
    applyFormToDraft();
    updateDependsOn();
    setDirtyHint(true);
  }

  function applyConfig() {
    appliedConfig = JSON.parse(JSON.stringify(draftConfig));
    setDirtyHint(false);
    addEvent('配置已应用');
  }

  function resetConfig() {
    if (!schema) return;
    draftConfig = JSON.parse(JSON.stringify(schema.defaults));
    draftToForm();
    updateDependsOn();
    setDirtyHint(true);
    addEvent('已恢复为默认配置（未应用）');
  }

  function setStatus(status) {
    currentState = status;
    var textMap = {
      idle: '就绪',
      connecting: '连接中...',
      recording: '录音中',
      recognizing: '识别中...'
    };
    statusText.textContent = textMap[status] || '就绪';
    statusDot.className = 'status-dot';
    if (status !== 'idle') {
      statusDot.className = 'status-dot ' + status;
    }
    if (status === 'idle') {
      micBtn.disabled = false;
      micBtn.classList.remove('recording');
    } else if (status === 'connecting') {
      micBtn.disabled = true;
    } else if (status === 'recording') {
      micBtn.disabled = false;
      micBtn.classList.add('recording');
    } else if (status === 'recognizing') {
      micBtn.disabled = true;
      micBtn.classList.remove('recording');
    }
    renderSummaryState();
  }

  function showError(msg) {
    errorArea.textContent = msg;
    errorArea.hidden = false;
    if (errorBox && errorSection) {
      errorBox.textContent = msg;
      errorSection.hidden = false;
    }
    setStatus('idle');
    statusDot.className = 'status-dot error';
    statusText.textContent = '错误';
    if (errorTimeout) {
      clearTimeout(errorTimeout);
    }
    errorTimeout = setTimeout(function() {
      hideError();
    }, 8000);
  }

  function hideError() {
    errorArea.hidden = true;
    if (errorSection) {
      errorSection.hidden = true;
    }
    if (errorTimeout) {
      clearTimeout(errorTimeout);
      errorTimeout = null;
    }
  }

  function setVolume(vol) {
    currentVolume = currentVolume * 0.8 + vol * 0.2;
    volumeBar.style.width = (currentVolume * 100) + '%';
  }

  function floatTo16BitPCM(float32Array) {
    var int16 = new Int16Array(float32Array.length);
    for (var i = 0; i < float32Array.length; i++) {
      var s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  function resampleTo16k(float32Array, fromRate) {
    if (fromRate === 16000) {
      return float32Array;
    }
    var newLength = Math.round(float32Array.length * 16000 / fromRate);
    var result = new Float32Array(newLength);
    for (var i = 0; i < newLength; i++) {
      var ratio = i * fromRate / 16000;
      var i0 = Math.floor(ratio);
      var i1 = Math.min(i0 + 1, float32Array.length - 1);
      var frac = ratio - i0;
      result[i] = float32Array[i0] * (1 - frac) + float32Array[i1] * frac;
    }
    return result;
  }

  function getSpeakerColor(idx) {
    var colors = ['#1a73e8', '#ea4335', '#34a853', '#f9ab00', '#9334e6', '#00acc1', '#ff6d01', '#46bdc6'];
    return colors[idx % colors.length];
  }

  function extractSpeakerId(utt) {
    if (utt == null) return -1;
    var v = utt.speaker_id != null ? utt.speaker_id : (utt.speakerId != null ? utt.speakerId : utt.speaker);
    if (v != null) {
      var n = parseInt(v, 10);
      if (!isNaN(n)) return n;
    }
    if (typeof utt.additions === 'object' && utt.additions != null) {
      var av = utt.additions.speaker_id != null ? utt.additions.speaker_id : (utt.additions.speakerId != null ? utt.additions.speakerId : utt.additions.speaker);
      if (av != null) {
        var an = parseInt(av, 10);
        if (!isNaN(an)) return an;
      }
    }
    return -1;
  }

  function createSpeakerBlock(speaker, text, isPartial) {
    var block = document.createElement('div');
    block.className = 'utt-block' + (isPartial ? ' utt-partial' : '');
    if (isPartial) {
      block.style.borderLeftColor = '#dadce0';
    } else if (speaker >= 0) {
      var color = getSpeakerColor(speaker);
      if (speakerBindings[speaker] && speakerBindings[speaker].color) {
        color = speakerBindings[speaker].color;
      }
      block.style.borderLeftColor = color;
      var badge = document.createElement('span');
      badge.className = getSpeakerLabelClass(speaker);
      var binding = speakerBindings[speaker];
      var status = binding ? (binding.status || 'unknown') : 'unknown';
      if (status !== 'guest') {
        badge.style.background = color;
      }
      badge.textContent = getSpeakerLabel(speaker);
      badge.dataset.speakerId = speaker;
      var canClick = voiceprintEnabled && (status !== 'matched_high' && status !== 'manual_bound');
      if (canClick) {
        badge.style.cursor = 'pointer';
        if (status === 'identifying') {
          badge.title = '声纹识别中...';
        } else if (status === 'matched_low') {
          badge.title = '低置信度识别，点击重新绑定';
        } else if (status === 'guest') {
          badge.title = '参会人，点击手动绑定';
        } else {
          badge.title = '点击手动绑定说话人';
        }
        badge.onclick = (function(spk) {
          return function() {
            if (voiceprintEnabled) {
              showManualBindDialog(spk);
            }
          };
        })(speaker);
      } else if (status === 'matched_high' || status === 'manual_bound') {
        badge.title = '已识别为：' + (binding ? binding.username : '');
      } else if (status === 'guest') {
        badge.title = '参会人';
      }
      block.appendChild(badge);
    } else {
      block.style.borderLeftColor = '#1a73e8';
    }
    var span = document.createElement('span');
    span.className = 'utt-text';
    span.textContent = text;
    block.appendChild(span);
    return block;
  }

  function showManualBindDialog(speakerId) {
    var validAttendees = getValidAttendees();
    if (validAttendees.length === 0) {
      var name = prompt('请输入说话人 ' + (speakerId + 1) + ' 的用户名：');
      if (name && name.trim()) {
        ws.send(JSON.stringify({ type: 'bind_speaker', speakerId: speakerId, username: name.trim() }));
      }
      return;
    }
    var options = validAttendees.map(function(a, i) { return (i + 1) + '. ' + a.name + (a.role ? '（' + a.role + '）' : ''); }).join('\n');
    var choice = prompt('请选择说话人 ' + (speakerId + 1) + ' 对应的参会人（输入编号），或直接输入用户名：\n\n' + options);
    if (choice == null) return;
    choice = choice.trim();
    if (!choice) return;
    var num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= validAttendees.length) {
      ws.send(JSON.stringify({ type: 'bind_speaker', speakerId: speakerId, username: validAttendees[num - 1].name }));
    } else {
      ws.send(JSON.stringify({ type: 'bind_speaker', speakerId: speakerId, username: choice }));
    }
  }

  function groupUtterancesBySpeaker(uttList) {
    var grouped = [];
    var lastSpk = -99;
    for (var i = 0; i < uttList.length; i++) {
      var utt = uttList[i];
      var t = (utt.text || '').trim();
      if (!t) continue;
      var spk = extractSpeakerId(utt);
      if (spk === lastSpk && grouped.length > 0) {
        grouped[grouped.length - 1].text += t;
      } else {
        grouped.push({ speaker: spk, text: t });
        lastSpk = spk;
      }
    }
    return grouped;
  }

  function renderTranscript() {
    resultArea.innerHTML = '';

    var grouped = groupUtterancesBySpeaker(finalizedUtterances);
    for (var i = 0; i < grouped.length; i++) {
      resultArea.appendChild(createSpeakerBlock(grouped[i].speaker, grouped[i].text, false));
    }

    if (currentState === 'recording' || currentState === 'recognizing') {
      if (partialText) {
        resultArea.appendChild(createSpeakerBlock(-1, partialText, true));
      } else if (grouped.length === 0) {
        var ph = document.createElement('span');
        ph.className = 'placeholder';
        ph.textContent = '正在听...';
        resultArea.appendChild(ph);
      }
    }

    if (grouped.length === 0 && !partialText && currentState === 'idle') {
      var ph2 = document.createElement('span');
      ph2.className = 'placeholder';
      ph2.textContent = '点击麦克风开始录音';
      resultArea.appendChild(ph2);
    }

    resultArea.scrollTop = resultArea.scrollHeight;
  }

  function handleResultMsg(msg) {
    if (msg.speakerOverrides && typeof msg.speakerOverrides === 'object') {
      Object.keys(msg.speakerOverrides).forEach(function(spkStr) {
        var spk = parseInt(spkStr, 10);
        var override = msg.speakerOverrides[spkStr];
        if (override && !speakerBindings[spk]) {
          speakerBindings[spk] = {
            status: override.status || 'unknown',
            username: override.username,
            color: override.color || getSpeakerColor(spk),
            score: override.score,
            confidence: override.confidence,
            isGuest: override.status === 'guest'
          };
        } else if (override && speakerBindings[spk] && override.username && speakerBindings[spk].status === 'unknown') {
          speakerBindings[spk].username = override.username;
          speakerBindings[spk].status = override.status;
          if (override.color) {
            speakerBindings[spk].color = override.color;
          }
        }
      });
    }

    var text = msg.text || '';
    var utts = msg.utterances;
    var isFinal = !!msg.isFinal;

    stats.lastLatency = Date.now() - stats.lastSendAt;
    if (!stats.firstResultReceived && stats.firstAudioSentAt > 0) {
      stats.firstPacketLatency = Date.now() - stats.firstAudioSentAt;
      stats.firstResultReceived = true;
      addEvent('收到首包 ' + stats.firstPacketLatency + 'ms');
    }

    if (!Array.isArray(utts) || utts.length === 0) {
      if (isFinal) {
        if (text && finalizedUtterances.length === 0) {
          finalizedUtterances = [{ text: text, definite: true, start_time: 0 }];
        }
        partialText = '';
      } else {
        partialText = text;
      }
      renderTranscript();
      renderStats();
      return;
    }

    var existingStartTimes = {};
    for (var e = 0; e < finalizedUtterances.length; e++) {
      existingStartTimes[finalizedUtterances[e].start_time] = true;
    }

    var newPartialText = '';
    for (var i = 0; i < utts.length; i++) {
      var u = utts[i];
      var t = (u.text || '').trim();
      var stKey = u.start_time;
      if (u.definite === true) {
        if (t && !existingStartTimes[stKey]) {
          finalizedUtterances.push(u);
          existingStartTimes[stKey] = true;
        } else if (t && existingStartTimes[stKey]) {
          for (var up = 0; up < finalizedUtterances.length; up++) {
            if (finalizedUtterances[up].start_time === stKey) {
              finalizedUtterances[up] = u;
              break;
            }
          }
        }
      } else {
        if (t) {
          newPartialText += t;
        }
      }
    }

    finalizedUtterances.sort(function(a, b) { return (a.start_time || 0) - (b.start_time || 0); });

    if (isFinal) {
      if (finalizedUtterances.length === 0 && text) {
        finalizedUtterances = [{ text: text, definite: true, start_time: 0 }];
      }
      partialText = '';
    } else {
      partialText = newPartialText || text;
    }

    renderTranscript();
    renderStats();
  }

  function resetStatsForSession() {
    stats.firstPacketLatency = null;
    stats.lastLatency = null;
    stats.audioDurationMs = 0;
    stats.lastError = '';
    stats.firstAudioSentAt = 0;
    stats.lastSendAt = 0;
    stats.firstResultReceived = false;
    stats.events = [];
    finalizedUtterances = [];
    partialText = '';
  }

  function sendAudioChunk() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    var totalLen = 0;
    for (var bi = 0; bi < pcmBuffer.length; bi++) {
      totalLen += pcmBuffer[bi].length;
    }
    if (totalLen === 0) {
      return;
    }
    var merged = new Uint8Array(totalLen);
    var offset = 0;
    for (var bj = 0; bj < pcmBuffer.length; bj++) {
      merged.set(pcmBuffer[bj], offset);
      offset += pcmBuffer[bj].length;
    }
    pcmBuffer = [];

    var CHUNK_SIZE = 6400;
    for (var i = 0; i < merged.length; i += CHUNK_SIZE) {
      var end = Math.min(i + CHUNK_SIZE, merged.length);
      var chunk = new Uint8Array(merged.buffer, i + merged.byteOffset, end - i);
      ws.send(chunk);
    }
    stats.audioDurationMs += 200;
    if (stats.firstAudioSentAt === 0) {
      stats.firstAudioSentAt = Date.now();
    }
    stats.lastSendAt = Date.now();
    renderStats();
  }

  function startAudioSending() {
    sendInterval = setInterval(sendAudioChunk, 200);
    setStatus('recording');
    recordingStartAt = Date.now();
    addEvent('开始发送音频');
  }

  function stopAudioSending(keepRecognizing) {
    if (sendInterval) {
      clearInterval(sendInterval);
      sendInterval = null;
    }
    if (scriptNode) {
      try { scriptNode.disconnect(); } catch(e) {}
      scriptNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch(e) {}
      sourceNode = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function(t) { t.stop(); });
      mediaStream = null;
    }
    if (audioContext) {
      try { audioContext.close(); } catch(e) {}
      audioContext = null;
    }
    pcmBuffer = [];
    setVolume(0);
  }

  function createEmptyAttendee() {
    return { name: '', role: '' };
  }

  function initAttendeeList() {
    attendeeList = [];
    for (var i = 0; i < 5; i++) {
      attendeeList.push(createEmptyAttendee());
    }
  }

  function getValidAttendeeCount() {
    var count = 0;
    for (var i = 0; i < attendeeList.length; i++) {
      if (attendeeList[i].name.trim() && attendeeList[i].role.trim()) {
        count++;
      }
    }
    return count;
  }

  function updateModalCount() {
    if (!modalCountEl) return;
    var validCount = getValidAttendeeCount();
    modalCountEl.textContent = '已录入 ' + validCount + ' 人';
    updateAttendeesButtonBadge(validCount);
  }

  function updateAttendeesButtonBadge(count) {
    if (!attendeesBtn) return;
    var existingBadge = attendeesBtn.querySelector('.attendee-count-badge');
    if (count > 0) {
      if (!existingBadge) {
        var badge = document.createElement('span');
        badge.className = 'attendee-count-badge';
        badge.style.background = '#d93025';
        badge.style.color = '#fff';
        badge.style.fontSize = '10px';
        badge.style.padding = '1px 5px';
        badge.style.borderRadius = '8px';
        badge.style.marginLeft = '4px';
        badge.style.fontWeight = '500';
        badge.textContent = count;
        attendeesBtn.appendChild(badge);
      } else {
        existingBadge.textContent = count;
      }
    } else if (existingBadge) {
      existingBadge.remove();
    }
  }

  function renderAttendeeRows() {
    if (!attendeeRowsEl) return;
    attendeeRowsEl.innerHTML = '';
    for (var i = 0; i < attendeeList.length; i++) {
      var row = document.createElement('div');
      row.className = 'attendee-row';
      row.setAttribute('data-index', i);

      var indexSpan = document.createElement('span');
      indexSpan.className = 'col-index';
      indexSpan.textContent = String(i + 1);
      row.appendChild(indexSpan);

      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = '姓名';
      nameInput.value = attendeeList[i].name;
      nameInput.setAttribute('data-field', 'name');
      nameInput.setAttribute('data-index', i);
      nameInput.addEventListener('input', onAttendeeFieldChange);
      row.appendChild(nameInput);

      var roleInput = document.createElement('input');
      roleInput.type = 'text';
      roleInput.placeholder = '岗位/角色';
      roleInput.value = attendeeList[i].role;
      roleInput.setAttribute('data-field', 'role');
      roleInput.setAttribute('data-index', i);
      roleInput.addEventListener('input', onAttendeeFieldChange);
      row.appendChild(roleInput);

      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'row-delete';
      deleteBtn.title = '删除此行';
      deleteBtn.setAttribute('data-index', i);
      deleteBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
      deleteBtn.addEventListener('click', onDeleteAttendeeRow);
      if (attendeeList.length <= 1) {
        deleteBtn.disabled = true;
        deleteBtn.style.opacity = '0.3';
        deleteBtn.style.cursor = 'not-allowed';
      }
      row.appendChild(deleteBtn);

      attendeeRowsEl.appendChild(row);
    }
    updateModalCount();
  }

  function onAttendeeFieldChange(e) {
    var idx = parseInt(e.target.getAttribute('data-index'), 10);
    var field = e.target.getAttribute('data-field');
    if (isNaN(idx) || idx < 0 || idx >= attendeeList.length) return;
    attendeeList[idx][field] = e.target.value;
    e.target.classList.remove('error');
    updateModalCount();
  }

  function onDeleteAttendeeRow(e) {
    var idx = parseInt(e.currentTarget.getAttribute('data-index'), 10);
    if (isNaN(idx) || attendeeList.length <= 1) return;
    attendeeList.splice(idx, 1);
    renderAttendeeRows();
  }

  function onAddAttendeeRow() {
    attendeeList.push(createEmptyAttendee());
    renderAttendeeRows();
    var rows = attendeeRowsEl.querySelectorAll('.attendee-row');
    if (rows.length > 0) {
      var lastRow = rows[rows.length - 1];
      var nameInput = lastRow.querySelector('input[data-field="name"]');
      if (nameInput) nameInput.focus();
    }
  }

  function openAttendeesModal() {
    attendeeList = savedAttendees.length > 0
      ? JSON.parse(JSON.stringify(savedAttendees))
      : [];
    if (attendeeList.length === 0) {
      initAttendeeList();
    }
    renderAttendeeRows();
    attendeesModal.hidden = false;
  }

  function closeAttendeesModal() {
    attendeesModal.hidden = true;
    var errorInputs = attendeeRowsEl.querySelectorAll('input.error');
    for (var i = 0; i < errorInputs.length; i++) {
      errorInputs[i].classList.remove('error');
    }
  }

  function validateAndSaveAttendees() {
    var hasError = false;
    var validEntries = [];
    var rows = attendeeRowsEl.querySelectorAll('.attendee-row');

    for (var i = 0; i < rows.length; i++) {
      var nameInput = rows[i].querySelector('input[data-field="name"]');
      var roleInput = rows[i].querySelector('input[data-field="role"]');
      var nameVal = (nameInput.value || '').trim();
      var roleVal = (roleInput.value || '').trim();
      var idx = parseInt(rows[i].getAttribute('data-index'), 10);

      nameInput.classList.remove('error');
      roleInput.classList.remove('error');

      var bothEmpty = !nameVal && !roleVal;
      var partialFilled = (nameVal && !roleVal) || (!nameVal && roleVal);

      if (partialFilled) {
        hasError = true;
        if (!nameVal) nameInput.classList.add('error');
        if (!roleVal) roleInput.classList.add('error');
      } else if (nameVal && roleVal) {
        validEntries.push({ name: nameVal, role: roleVal });
      }
    }

    if (hasError) {
      addEvent('参会名单验证失败：姓名和岗位均为必填项');
      return;
    }

    savedAttendees = validEntries;
    updateModalCount();
    updateAttendeesButtonBadge(validEntries.length);
    closeAttendeesModal();
    addEvent('参会名单已保存：' + validEntries.length + ' 人');
    renderTranscript();
  }

  function cleanup() {
    stopAudioSending(false);
    if (ws) {
      try { ws.close(); } catch(e) {}
      ws = null;
    }
    disableConfigForm(false);
    stats.clientWsConnected = false;
    stats.doubaoStatus = 'disconnected';
    setVolume(0);
    renderStats();
  }

  function initWs() {
    if (ws) {
      try { ws.close(); } catch(e) {}
      ws = null;
    }
    var urlParams = new URLSearchParams(location.search);
    var serverOverride = urlParams.get('server');
    var wsUrl;
    if (serverOverride) {
      wsUrl = serverOverride.startsWith('ws') ? serverOverride : 'ws://' + serverOverride;
      if (!wsUrl.endsWith('/ws')) wsUrl = wsUrl.replace(/\/$/, '') + '/ws';
    } else {
      var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = protocol + '//' + location.host + getBasePath() + 'ws';
    }
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    var recordingContainer = document.getElementById('recordingPlayerContainer');
    if (recordingContainer) {
      recordingContainer.innerHTML = '';
    }

    ws.onopen = function() {
      stats.clientWsConnected = true;
      stats.doubaoStatus = 'disconnected';
      addEvent('WebSocket 已连接');
      renderStats();
    };

    ws.onmessage = function(event) {
      var msg = JSON.parse(event.data);
      if (msg.type === 'connected') {
        stats.doubaoStatus = 'connected';
        stats.logid = msg.logid || '';
        stats.firstResultReceived = false;
        voiceprintEnabled = !!msg.voiceprintEnabled;
        speakerBindings = {};
        addEvent('豆包已连接' + (voiceprintEnabled ? '（声纹自动识别已启用）' : ''));
        if (recordingStartAt > 0 || currentState === 'connecting') {
          startAudioSending();
        }
        var diffKeys = diffConfigs(appliedConfig, msg.appliedConfig);
        if (diffKeys.length > 0) {
          showWarning('实际生效参数与本地配置存在差异：' + diffKeys.join(', '));
        } else {
          hideWarning();
        }
        if (msg.appliedConfig) {
          appliedConfig = JSON.parse(JSON.stringify(msg.appliedConfig));
          renderAppliedConfig();
        }
        renderStats();
      } else if (msg.type === 'speaker_identifying') {
        var spk = msg.speakerId;
        speakerBindings[spk] = { status: 'identifying', color: getSpeakerColor(spk) };
        addEvent('说话人' + (spk + 1) + ' 识别中...');
        renderTranscript();
      } else if (msg.type === 'speaker_matched') {
        speakerBindings[msg.speakerId] = {
          status: msg.confidence === 'high' ? 'matched_high' : 'matched_low',
          username: msg.username,
          color: msg.color || getSpeakerColor(msg.speakerId),
          score: msg.score,
          confidence: msg.confidence,
          isGuest: false
        };
        if (msg.confidence === 'high') {
          addEvent('说话人' + (msg.speakerId + 1) + ' 已识别为：' + msg.username + '（' + msg.score + '分' + (msg.method ? '，' + msg.method : '') + '）');
        } else {
          addEvent('说话人' + (msg.speakerId + 1) + ' 初步识别为：' + msg.username + '？（' + msg.score + '分，低置信度）');
        }
        renderTranscript();
      } else if (msg.type === 'speaker_guest') {
        speakerBindings[msg.speakerId] = {
          status: 'guest',
          username: msg.guestName,
          color: msg.color || getSpeakerColor(msg.speakerId),
          isGuest: true
        };
        addEvent('说话人' + (msg.speakerId + 1) + ' 标记为参会人');
        renderTranscript();
      } else if (msg.type === 'speaker_matching') {
        var spkOld = msg.speakerId;
        speakerBindings[spkOld] = { status: 'identifying', color: getSpeakerColor(spkOld) };
        addEvent('说话人' + (spkOld + 1) + ' 识别中...');
        renderTranscript();
      } else if (msg.type === 'speaker_match_failed') {
        if (!speakerBindings[msg.speakerId]) {
          speakerBindings[msg.speakerId] = { status: 'unknown', color: getSpeakerColor(msg.speakerId), isGuest: false };
        }
        addEvent('说话人' + (msg.speakerId + 1) + ' 声纹识别失败（置信度 ' + msg.score + '），可点击说话人标签手动绑定');
        renderTranscript();
      } else if (msg.type === 'speaker_match_error') {
        if (!speakerBindings[msg.speakerId]) {
          speakerBindings[msg.speakerId] = { status: 'unknown', color: getSpeakerColor(msg.speakerId), isGuest: false };
        }
        addEvent('说话人' + (msg.speakerId + 1) + ' 声纹识别出错：' + msg.error);
        renderTranscript();
      } else if (msg.type === 'result') {
        handleResultMsg(msg);
        if (msg.isFinal) {
          addEvent('识别完成');
          setStatus('idle');
          disableConfigForm(false);
          stats.doubaoStatus = 'disconnected';
          saveLastSession();
          renderSummaryState();
          renderStats();
        }
      } else if (msg.type === 'error') {
        stats.doubaoStatus = 'error';
        stats.lastError = msg.message;
        addEvent('错误: ' + msg.message);
        showError('识别错误(' + msg.code + '): ' + msg.message);
        setStatus('idle');
        stopAudioSending(false);
        disableConfigForm(false);
        renderStats();
      } else if (msg.type === 'recording_ready') {
        var container = document.getElementById('recordingPlayerContainer');
        if (container) {
          container.innerHTML = '';
          var audio = document.createElement('audio');
          audio.controls = true;
          var recUrl = msg.url;
          if (recUrl.charAt(0) === '/') {
            recUrl = getBasePath() + recUrl.substring(1);
          }
          audio.src = recUrl;
          audio.style.width = '100%';
          audio.style.marginTop = '8px';
          var label = document.createElement('div');
          label.style.cssText = 'font-size:13px;color:#5f6368;margin-bottom:4px;';
          label.textContent = '🔊 本次会话录音';
          container.appendChild(label);
          container.appendChild(audio);
          addEvent('录音已生成，可播放');
        }
        window.__currentRecordingUrl = msg.url;
        var aucToolbar = document.getElementById('aucToolbar');
        var aucTranscribeBtn = document.getElementById('aucTranscribeBtn');
        var aucHint = document.getElementById('aucHint');
        if (aucToolbar) aucToolbar.hidden = false;
        if (aucTranscribeBtn) aucTranscribeBtn.disabled = false;
        if (aucHint) aucHint.textContent = '录音已就绪，可提交转写';
      }
    };

    ws.onerror = function() {
      stats.clientWsConnected = false;
      stats.doubaoStatus = 'disconnected';
      addEvent('WebSocket 错误');
      renderStats();
    };

    ws.onclose = function() {
      stats.clientWsConnected = false;
      if (currentState === 'recording' || currentState === 'connecting') {
        stats.doubaoStatus = 'disconnected';
        showError('连接已断开');
        setStatus('idle');
        stopAudioSending(false);
        disableConfigForm(false);
      } else {
        stats.doubaoStatus = 'disconnected';
      }
      addEvent('WebSocket 已断开');
      renderStats();
      ws = null;
      setTimeout(function() {
        if (!ws && currentState === 'idle') {
          initWs();
        }
      }, 2000);
    };
  }

  function startRecording() {
    hideError();
    var diffKeys = diffConfigs(draftConfig, appliedConfig);
    if (diffKeys.length > 0 || appliedConfig == null) {
      applyConfig();
    }
    setStatus('connecting');
    addEvent('开始录音');
    stats.doubaoStatus = 'connecting';
    resetStatsForSession();
    var recordingContainer = document.getElementById('recordingPlayerContainer');
    if (recordingContainer) {
      recordingContainer.innerHTML = '';
    }
    renderTranscript();
    renderStats();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('无法访问麦克风：当前页面不是安全上下文（HTTPS/localhost），浏览器已禁用麦克风权限。请使用 HTTPS 地址访问本页面。');
      setStatus('idle');
      disableConfigForm(false);
      return;
    }

    try {
      var micPromise = navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (syncErr) {
      showError('无法访问麦克风：' + syncErr.message);
      setStatus('idle');
      disableConfigForm(false);
      return;
    }

    micPromise.then(function(stream) {
      mediaStream = stream;
      var AudioCtx = window.AudioContext || window.webkitAudioContext;
      audioContext = new AudioCtx();
      sourceNode = audioContext.createMediaStreamSource(stream);
      scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
      pcmBuffer = [];

      scriptNode.onaudioprocess = function(e) {
        var inputData = e.inputBuffer.getChannelData(0);
        var sum = 0;
        for (var i = 0; i < inputData.length; i++) {
          sum += inputData[i] * inputData[i];
        }
        var rms = Math.sqrt(sum / inputData.length);
        setVolume(Math.min(1, rms * 3));

        var resampled = resampleTo16k(inputData, audioContext.sampleRate);
        var int16 = floatTo16BitPCM(resampled);
        var bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
        pcmBuffer.push(bytes);
      };

      sourceNode.connect(scriptNode);
      scriptNode.connect(audioContext.destination);

      appliedConfig = JSON.parse(JSON.stringify(draftConfig));
      setDirtyHint(false);
      disableConfigForm(true);
      renderAppliedConfig();

      var hwPayload = buildHotwordStartPayload();
      var hwList = hwPayload.hwList;
      var cwMap = hwPayload.cwMap;
      var startMsg = { type: 'start', config: draftConfig };
      if (hwList.length > 0) startMsg.hotwords = hwList;
      if (cwMap) startMsg.correct_words = cwMap;
      var startMsgStr = JSON.stringify(startMsg);
      var hwDesc = hwList.length > 0
        ? '（含' + hwList.length + '个自定义热词' + (cwMap ? '、' + Object.keys(cwMap).length + '条替换词' : '') + (hwPayload.truncated ? '，已自动截断超出部分' : '') + '）'
        : '（使用默认热词表）';

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(startMsgStr);
        addEvent('已发送开始请求' + hwDesc);
      } else {
        addEvent('WebSocket 未连接，正在重连...');
        initWs();
        setTimeout(function() {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(startMsgStr);
            addEvent('已发送开始请求' + hwDesc);
          } else {
            showError('无法连接服务器');
            stopAudioSending(false);
            disableConfigForm(false);
            setStatus('idle');
          }
        }, 1000);
      }

      renderStats();
    }).catch(function(err) {
      showError('无法访问麦克风：' + err.message);
      setStatus('idle');
      disableConfigForm(false);
    });
  }

  function stopRecording() {
    if (currentState !== 'recording') {
      return;
    }
    setStatus('recognizing');
    addEvent('停止录音');

    if (!partialText && finalizedUtterances.length === 0) {
      resultArea.innerHTML = '<span class="loading">识别中...</span>';
    }

    sendAudioChunk();

    stopAudioSending(true);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop' }));
      addEvent('已发送停止请求');
    }

    setTimeout(function() {
      if (currentState === 'recognizing') {
        addEvent('识别完成(超时)');
        setStatus('idle');
        disableConfigForm(false);
        stats.doubaoStatus = 'disconnected';
        saveLastSession();
        renderSummaryState();
        renderStats();
      }
    }, 5000);
  }

  function saveLastSession() {
    var grouped = groupUtterancesBySpeaker(finalizedUtterances);
    var turns = [];
    var parts = [];
    for (var i = 0; i < grouped.length; i++) {
      var g = grouped[i];
      turns.push({ speaker: g.speaker, text: g.text });
      if (g.speaker >= 0) {
        var speakerName = getSpeakerLabel(g.speaker);
        parts.push(speakerName + '：' + g.text);
      } else {
        parts.push(g.text);
      }
    }
    var plainText = parts.join('\n');
    if (!plainText && partialText) plainText = partialText;
    lastTranscript = plainText;
    lastTurns = turns;
    lastDurationMs = recordingStartAt > 0 ? Date.now() - recordingStartAt : 0;
  }

  function formatShortTime(ts) {
    var d = new Date(ts);
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function renderSummaryState() {
    if (!summaryBtn || !clearSummariesBtn || !summaryList) return;
    var busy = summaryBusy;
    var recording = currentState === 'recording' || currentState === 'recognizing' || currentState === 'connecting';
    var hasLast = !recording && lastTranscript.trim().length > 0 && !busy;
    summaryBtn.disabled = !hasLast;
    clearSummariesBtn.disabled = busy || summaryItems.length === 0;
    if (summaryHint) {
      if (busy) {
        summaryHint.textContent = '正在生成纪要...';
      } else if (recording) {
        summaryHint.textContent = '录音中无法生成纪要';
      } else if (!lastTranscript) {
        summaryHint.textContent = '录音结束后可生成会议纪要';
      } else if (!llmConfigured) {
        summaryHint.textContent = '未配置大模型';
      } else {
        summaryHint.textContent = '可针对上一轮录音生成纪要';
      }
    }
    summaryList.innerHTML = '';
    if (summaryItems.length === 0 && !busy) {
      var ph = document.createElement('span');
      ph.className = 'placeholder';
      ph.textContent = '暂无会议纪要';
      summaryList.appendChild(ph);
      return;
    }
    for (var i = 0; i < summaryItems.length; i++) {
      var it = summaryItems[i];
      var item;
      if (it.id === 'pending') {
        item = document.createElement('span');
        item.className = 'summary-item loading';
        item.innerHTML = '<span class="s-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg></span><span class="s-time">生成中…</span>';
      } else {
        item = document.createElement('a');
        item.className = 'summary-item';
        item.href = it.url;
        item.target = '_blank';
        item.rel = 'noopener';
        item.title = it.snippet || '会议纪要';
        var icon = document.createElement('span');
        icon.className = 's-icon';
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>';
        var tm = document.createElement('span');
        tm.className = 's-time';
        tm.textContent = formatShortTime(it.ts);
        item.appendChild(icon);
        item.appendChild(tm);
        if (it.snippet) {
          var sn = document.createElement('span');
          sn.className = 's-snippet';
          sn.textContent = it.snippet;
          item.appendChild(sn);
        }
      }
      summaryList.appendChild(item);
    }
  }

  function loadSummaries() {
    return fetch(getBasePath() + 'api/summaries').then(function(r) { return r.json(); }).then(function(data) {
      summaryItems = Array.isArray(data.items) ? data.items : [];
      renderSummaryState();
    }).catch(function() {
      summaryItems = [];
      renderSummaryState();
    });
  }

  function getValidAttendees() {
    var valid = [];
    for (var i = 0; i < savedAttendees.length; i++) {
      var name = savedAttendees[i].name.trim();
      var role = savedAttendees[i].role ? savedAttendees[i].role.trim() : '';
      if (name) {
        valid.push({ name: name, role: role });
      }
    }
    return valid;
  }

  function getSpeakerLabel(speakerId, includeRole) {
    if (speakerId < 0) return '';
    var binding = speakerBindings[speakerId];
    if (!binding) {
      return '说话人 ' + (speakerId + 1);
    }
    var status = binding.status || 'unknown';
    if (status === 'identifying') {
      return '识别中...';
    }
    if (status === 'matched_high' || status === 'manual_bound') {
      if (includeRole && binding.role) {
        return binding.username + '（' + binding.role + '）';
      }
      return binding.username;
    }
    if (status === 'matched_low') {
      return binding.username + '?';
    }
    if (status === 'guest') {
      return binding.username;
    }
    if (binding.username) {
      return binding.username;
    }
    return '说话人 ' + (speakerId + 1);
  }

  function getSpeakerLabelClass(speakerId) {
    if (speakerId < 0) return '';
    var binding = speakerBindings[speakerId];
    if (!binding) {
      return 'speaker-badge speaker-unidentified';
    }
    var status = binding.status || 'unknown';
    if (status === 'matched_high' || status === 'manual_bound') {
      return 'speaker-badge speaker-identified';
    }
    if (status === 'matched_low') {
      return 'speaker-badge speaker-identified-low';
    }
    if (status === 'identifying') {
      return 'speaker-badge speaker-matching';
    }
    if (status === 'guest') {
      return 'speaker-badge speaker-guest';
    }
    return 'speaker-badge speaker-unidentified';
  }

  function replaceSpeakerLabelsInText(text) {
    var validAttendees = getValidAttendees();
    if (validAttendees.length === 0) return text;
    return text.replace(/说话人\s*(\d+)[：:]/g, function(match, numStr) {
      var idx = parseInt(numStr, 10) - 1;
      if (idx >= 0 && idx < validAttendees.length) {
        var a = validAttendees[idx];
        return a.name + '：';
      }
      return match;
    });
  }

  function doSummarize() {
    if (summaryBusy || !lastTranscript) return;
    if (!llmConfigured) {
      showError('未配置大模型 API Key，请在服务器端设置 ARK_API_KEY 后重试');
      return;
    }
    summaryBusy = true;
    addEvent('正在生成会议纪要...');
    var pendingItem = { id: 'pending', ts: Date.now(), timeLabel: '', url: '#', snippet: '生成中...' };
    summaryItems.unshift(pendingItem);
    renderSummaryState();

    var validAttendees = getValidAttendees();

    fetch(getBasePath() + 'api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: lastTranscript,
        turns: lastTurns,
        durationMs: lastDurationMs,
        attendees: validAttendees,
      }),
    }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, json: j }; }); })
      .then(function(resp) {
        summaryItems = summaryItems.filter(function(x) { return x.id !== 'pending'; });
        summaryBusy = false;
        if (resp.ok && resp.json.ok && resp.json.summary) {
          summaryItems.unshift(resp.json.summary);
          if (summaryItems.length > 5) summaryItems = summaryItems.slice(0, 5);
          addEvent('会议纪要已生成');
          renderSummaryState();
          window.open(resp.json.summary.url, '_blank', 'noopener');
        } else {
          var msg = (resp.json && resp.json.message) || '生成失败';
          addEvent('纪要生成失败: ' + msg);
          showError(msg);
          renderSummaryState();
        }
      })
      .catch(function(err) {
        summaryItems = summaryItems.filter(function(x) { return x.id !== 'pending'; });
        summaryBusy = false;
        addEvent('纪要生成失败: ' + err.message);
        showError('网络错误: ' + err.message);
        renderSummaryState();
      });
  }

  function clearSummaries() {
    if (summaryBusy) return;
    if (!window.confirm('确定要清空所有会议纪要吗？此操作不可恢复。')) return;
    fetch(getBasePath() + 'api/summaries', { method: 'DELETE' }).then(function(r) { return r.json(); })
      .then(function() {
        summaryItems = [];
        addEvent('已清空所有会议纪要');
        renderSummaryState();
      })
      .catch(function(err) {
        showError('清空失败: ' + err.message);
      });
  }

  function parseImportedText(text) {
    var lines = text.split(/\r?\n/);
    var turns = [];
    var parts = [];
    var speakerPattern = /^(.+?)[：:]\s*(.*)$/;
    var speakerNum = 0;
    var speakerMap = {};
    var currentSpeakerId = -1;
    var currentText = '';
    var validAttendees = getValidAttendees();

    function resolveSpeakerName(rawName, speakerId) {
      var genericMatch = rawName.match(/^说话人\s*(\d+)$/);
      if (genericMatch) {
        var idx = parseInt(genericMatch[1], 10) - 1;
        if (idx >= 0 && idx < validAttendees.length) {
          return validAttendees[idx].name;
        }
        return rawName;
      }
      return rawName;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      var match = line.match(speakerPattern);
      if (match) {
        var speakerName = match[1].trim();
        var content = match[2].trim();

        if (currentText && currentSpeakerId >= 0) {
          turns.push({ speaker: currentSpeakerId, text: currentText.trim() });
        }

        var isGenericSpeaker = /^说话人\s*\d+$/.test(speakerName);
        var resolvedName = resolveSpeakerName(speakerName, speakerNum);
        var spkKey = resolvedName;

        if (isGenericSpeaker) {
          var numMatch = speakerName.match(/\d+/);
          currentSpeakerId = numMatch ? (parseInt(numMatch[0], 10) - 1) : speakerNum;
        } else if (speakerMap[spkKey] !== undefined) {
          currentSpeakerId = speakerMap[spkKey];
        } else {
          currentSpeakerId = speakerNum;
          speakerMap[spkKey] = speakerNum;
          speakerNum++;
        }

        currentText = content;
        if (content) {
          parts.push(resolvedName + '：' + content);
        }
      } else {
        if (currentText) {
          currentText += line;
          parts[parts.length - 1] = parts[parts.length - 1] + line;
        } else {
          currentText = line;
          currentSpeakerId = speakerNum;
          speakerNum++;
          parts.push(line);
        }
      }
    }

    if (currentText && currentSpeakerId >= 0) {
      turns.push({ speaker: currentSpeakerId, text: currentText.trim() });
    }

    var transcript = parts.join('\n');
    transcript = replaceSpeakerLabelsInText(transcript);

    return {
      transcript: transcript,
      turns: turns
    };
  }

  function openImportModal() {
    if (!importModal) return;
    importTextArea.value = '';
    importFileName.textContent = '';
    importFileInput.value = '';
    updateImportCharCount();
    importGenerateBtn.disabled = true;
    importModal.hidden = false;
    setTimeout(function() { importTextArea.focus(); }, 100);
  }

  function closeImportModal() {
    if (!importModal) return;
    importModal.hidden = true;
  }

  function updateImportCharCount() {
    if (!importCharCount || !importTextArea) return;
    var len = importTextArea.value.trim().length;
    importCharCount.textContent = len + ' 字';
    importGenerateBtn.disabled = len === 0 || summaryBusy;
  }

  function handleImportFileSelect(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(ev) {
      var text = ev.target.result;
      if (typeof text === 'string') {
        importTextArea.value = text;
        importFileName.textContent = file.name;
        updateImportCharCount();
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  function doImportAndSummarize() {
    if (summaryBusy) return;
    var text = importTextArea.value.trim();
    if (!text) return;
    if (!llmConfigured) {
      showError('未配置大模型 API Key，请在服务器端设置 ARK_API_KEY 后重试');
      return;
    }

    var parsed = parseImportedText(text);
    if (!parsed.transcript) {
      showError('导入内容为空');
      return;
    }

    lastTranscript = parsed.transcript;
    lastTurns = parsed.turns;
    lastDurationMs = 0;

    closeImportModal();
    addEvent('会议内容已导入，正在生成纪要...');

    var validAttendees = getValidAttendees();

    summaryBusy = true;
    var pendingItem = { id: 'pending', ts: Date.now(), timeLabel: '', url: '#', snippet: '生成中...' };
    summaryItems.unshift(pendingItem);
    renderSummaryState();

    fetch(getBasePath() + 'api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transcript: lastTranscript,
        turns: lastTurns,
        durationMs: lastDurationMs,
        attendees: validAttendees,
      }),
    }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, json: j }; }); })
      .then(function(resp) {
        summaryItems = summaryItems.filter(function(x) { return x.id !== 'pending'; });
        summaryBusy = false;
        if (resp.ok && resp.json.ok && resp.json.summary) {
          summaryItems.unshift(resp.json.summary);
          if (summaryItems.length > 5) summaryItems = summaryItems.slice(0, 5);
          addEvent('会议纪要已生成（导入模式）');
          renderSummaryState();
          window.open(resp.json.summary.url, '_blank', 'noopener');
        } else {
          var msg = (resp.json && resp.json.message) || '生成失败';
          addEvent('纪要生成失败: ' + msg);
          showError(msg);
          renderSummaryState();
        }
      })
      .catch(function(err) {
        summaryItems = summaryItems.filter(function(x) { return x.id !== 'pending'; });
        summaryBusy = false;
        addEvent('纪要生成失败: ' + err.message);
        showError('网络错误: ' + err.message);
        renderSummaryState();
      });
  }

  document.addEventListener('DOMContentLoaded', function() {
    micBtn = document.getElementById('micBtn');
    statusText = document.getElementById('statusText');
    statusDot = document.getElementById('statusDot');
    volumeBar = document.getElementById('volumeBar');
    resultArea = document.getElementById('resultArea');
    errorArea = document.getElementById('errorArea');
    configForm = document.getElementById('configForm');
    applyBtn = document.getElementById('applyBtn');
    resetBtn = document.getElementById('resetBtn');
    configHint = document.getElementById('configHint');
    configWarning = document.getElementById('configWarning');
    warningBanner = document.getElementById('warningBanner');
    connectionStatus = document.getElementById('connectionStatus');
    metricsStatus = document.getElementById('metricsStatus');
    appliedConfigDisplay = document.getElementById('appliedConfigDisplay');
    eventLog = document.getElementById('eventLog');
    errorSection = document.getElementById('errorSection');
    errorBox = document.getElementById('errorBox');
    attendeesBtn = document.getElementById('attendeesBtn');
    attendeesModal = document.getElementById('attendeesModal');
    modalCloseBtn = document.getElementById('modalCloseBtn');
    modalCancelBtn = document.getElementById('modalCancelBtn');
    modalSaveBtn = document.getElementById('modalSaveBtn');
    addRowBtn = document.getElementById('addRowBtn');
    attendeeRowsEl = document.getElementById('attendeeRows');
    modalCountEl = document.getElementById('modalCount');
    summaryBtn = document.getElementById('summaryBtn');
    clearSummariesBtn = document.getElementById('clearSummariesBtn');
    importBtn = document.getElementById('importBtn');
    summaryList = document.getElementById('summaryList');
    summaryHint = document.getElementById('summaryHint');
    importModal = document.getElementById('importModal');
    importModalCloseBtn = document.getElementById('importModalCloseBtn');
    importModalCancelBtn = document.getElementById('importModalCancelBtn');
    importGenerateBtn = document.getElementById('importGenerateBtn');
    importFileBtn = document.getElementById('importFileBtn');
    importFileInput = document.getElementById('importFileInput');
    importTextArea = document.getElementById('importTextArea');
    importFileName = document.getElementById('importFileName');
    importCharCount = document.getElementById('importCharCount');

    if (applyBtn) {
      applyBtn.addEventListener('click', applyConfig);
    }
    if (resetBtn) {
      resetBtn.addEventListener('click', resetConfig);
    }
    if (summaryBtn) {
      summaryBtn.addEventListener('click', doSummarize);
    }
    if (clearSummariesBtn) {
      clearSummariesBtn.addEventListener('click', clearSummaries);
    }
    if (importBtn) {
      importBtn.addEventListener('click', openImportModal);
    }
    if (importModalCloseBtn) {
      importModalCloseBtn.addEventListener('click', closeImportModal);
    }
    if (importModalCancelBtn) {
      importModalCancelBtn.addEventListener('click', closeImportModal);
    }
    if (importGenerateBtn) {
      importGenerateBtn.addEventListener('click', doImportAndSummarize);
    }
    if (importFileBtn && importFileInput) {
      importFileBtn.addEventListener('click', function() { importFileInput.click(); });
      importFileInput.addEventListener('change', handleImportFileSelect);
    }
    if (importTextArea) {
      importTextArea.addEventListener('input', updateImportCharCount);
    }
    if (attendeesBtn) {
      attendeesBtn.addEventListener('click', openAttendeesModal);
    }
    if (modalCloseBtn) {
      modalCloseBtn.addEventListener('click', closeAttendeesModal);
    }
    if (modalCancelBtn) {
      modalCancelBtn.addEventListener('click', closeAttendeesModal);
    }
    if (modalSaveBtn) {
      modalSaveBtn.addEventListener('click', validateAndSaveAttendees);
    }
    if (addRowBtn) {
      addRowBtn.addEventListener('click', onAddAttendeeRow);
    }
    if (attendeesModal) {
      attendeesModal.addEventListener('click', function(e) {
        if (e.target === attendeesModal) {
          closeAttendeesModal();
        }
      });
    }
    if (importModal) {
      importModal.addEventListener('click', function(e) {
        if (e.target === importModal) {
          closeImportModal();
        }
      });
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (attendeesModal && !attendeesModal.hidden) {
          closeAttendeesModal();
        } else if (importModal && !importModal.hidden) {
          closeImportModal();
        }
      }
    });

    initHotwordCounters();

    micBtn.addEventListener('click', function() {
      if (currentState === 'idle') {
        startRecording();
      } else if (currentState === 'recording') {
        stopRecording();
      }
    });

    setStatus('idle');
    renderStats();
    renderTranscript();
    renderSummaryState();

    fetch(getBasePath() + 'api/config-schema').then(function(resp) {
      return resp.json();
    }).then(function(data) {
      schema = data;
      draftConfig = JSON.parse(JSON.stringify(schema.defaults));
      appliedConfig = null;
      renderForm();
      draftToForm();
      updateDependsOn();
      setDirtyHint(false);
      addEvent('页面加载完成，配置 schema 已加载');
      renderStats();
      renderAppliedConfig();
    }).catch(function(err) {
      addEvent('加载配置失败: ' + err.message);
    });

    fetch(getBasePath() + 'api/llm-status').then(function(r) { return r.json(); }).then(function(d) {
      llmConfigured = !!d.configured;
      renderSummaryState();
    }).catch(function() {});

    fetch(getBasePath() + 'api/summaries').then(function(r) { return r.json(); }).then(function(data) {
      summaryItems = Array.isArray(data.items) ? data.items : [];
      renderSummaryState();
    }).catch(function() {
      summaryItems = [];
      renderSummaryState();
    });

    initWs();

    window.addEventListener('beforeunload', cleanup);
  });
})();

// ============ 声纹管理功能 ============
(function() {
  function getBasePath() {
    var p = location.pathname;
    if (p.endsWith('/')) return p;
    var idx = p.lastIndexOf('/');
    return idx >= 0 ? p.substring(0, idx + 1) : '/';
  }

  function floatTo16BitPCM(float32Array) {
    var int16 = new Int16Array(float32Array.length);
    for (var i = 0; i < float32Array.length; i++) {
      var s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16;
  }

  var basePath = getBasePath();
  function apiUrl(path) {
    return basePath + path.replace(/^\//, '');
  }

  // DOM 元素
  var voiceprintBtn = document.getElementById('voiceprintBtn');
  var overlay = document.getElementById('voiceprintModalOverlay');
  var modal = document.getElementById('voiceprintModal');
  var closeBtn = document.getElementById('vpModalCloseBtn');
  var cancelBtn = document.getElementById('vpModalCancelBtn');
  var refreshBtn = document.getElementById('vpRefreshBtn');
  var listBody = document.getElementById('vpListBody');
  var speakerNameInput = document.getElementById('vpSpeakerName');
  var sourceRadios = document.querySelectorAll('input[name="vpSource"]');
  var uploadArea = document.getElementById('vpUploadArea');
  var fileInput = document.getElementById('vpFileInput');
  var fileSelectedDiv = document.getElementById('vpFileSelected');
  var fileNameSpan = document.getElementById('vpFileName');
  var fileRemoveBtn = document.getElementById('vpFileRemoveBtn');
  var recordArea = document.getElementById('vpRecordArea');
  var readGuide = document.getElementById('vpReadGuide');
  var recordingUI = document.getElementById('vpRecordingUI');
  var startRecordBtn = document.getElementById('vpStartRecordBtn');
  var finishBtn = document.getElementById('vpFinishBtn');
  var rerecordBtn = document.getElementById('vpRerecordBtn');
  var waveformCanvas = document.getElementById('vpWaveformCanvas');
  var recordTimer = document.getElementById('vpRecordTimer');
  var previewAudio = document.getElementById('vpPreviewAudio');
  var statusDiv = document.getElementById('vpStatus');
  var registerBtn = document.getElementById('vpRegisterBtn');

  // 状态
  var uploadedFileUrl = null;
  var uploadedBlob = null;
  var isRecording = false;
  var audioCtx = null;
  var mediaStream = null;
  var scriptNode = null;
  var sourceNode = null;
  var analyser = null;
  var recordStartTime = 0;
  var timerInterval = null;
  var animationFrameId = null;
  var recordedBuffers = [];
  var recordedBlob = null;
  var isModalOpen = false;
  var waveformHistory = [];

  // ============ Modal 打开/关闭 ============
  function openModal() {
    if (isModalOpen) return;
    isModalOpen = true;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    loadList();
    resetForm();
  }

  function closeModal() {
    if (!isModalOpen) return;
    if (isRecording) stopRecording();
    cleanupRecording();
    isModalOpen = false;
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  if (voiceprintBtn) voiceprintBtn.addEventListener('click', openModal);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeModal();
    });
  }

  // ============ 表单重置 ============
  function resetForm() {
    if (speakerNameInput) speakerNameInput.value = '';
    if (sourceRadios.length > 0) {
      sourceRadios[0].checked = true;
      switchSource('upload');
    }
    uploadedFileUrl = null;
    uploadedBlob = null;
    recordedBlob = null;
    if (fileSelectedDiv) fileSelectedDiv.hidden = true;
    if (previewAudio) {
      previewAudio.style.display = 'none';
      previewAudio.src = '';
    }
    resetRecordingUI();
    setStatus('', '');
    updateRegisterBtn();
  }

  function resetRecordingUI() {
    if (readGuide) readGuide.hidden = false;
    if (recordingUI) recordingUI.hidden = true;
    if (recordTimer) recordTimer.textContent = '00:00';
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    waveformHistory = [];
  }

  // ============ 状态提示 ============
  function setStatus(msg, type) {
    if (!statusDiv) return;
    if (!msg) {
      statusDiv.hidden = true;
      statusDiv.className = 'vp-status';
      statusDiv.textContent = '';
      return;
    }
    statusDiv.hidden = false;
    statusDiv.className = 'vp-status ' + (type || '');
    statusDiv.textContent = msg;
  }

  // ============ 切换音频来源 ============
  function switchSource(source) {
    if (source === 'upload') {
      if (uploadArea) uploadArea.style.display = '';
      if (recordArea) recordArea.hidden = true;
      recordedBlob = null;
      if (previewAudio) {
        previewAudio.style.display = 'none';
      }
      cleanupRecording();
      resetRecordingUI();
    } else {
      if (uploadArea) uploadArea.style.display = 'none';
      if (fileSelectedDiv) fileSelectedDiv.hidden = true;
      if (recordArea) recordArea.hidden = false;
      resetRecordingUI();
      uploadedFileUrl = null;
      uploadedBlob = null;
    }
    setStatus('', '');
    updateRegisterBtn();
  }

  for (var i = 0; i < sourceRadios.length; i++) {
    (function(radio) {
      radio.addEventListener('change', function() {
        if (radio.checked) switchSource(radio.value);
      });
    })(sourceRadios[i]);
  }

  // ============ 更新注册按钮状态 ============
  function updateRegisterBtn() {
    if (!registerBtn || !speakerNameInput) return;
    var name = speakerNameInput.value.trim();
    var checkedRadio = document.querySelector('input[name="vpSource"]:checked');
    var source = checkedRadio ? checkedRadio.value : 'upload';
    var hasAudio = source === 'upload' ? !!uploadedFileUrl : !!recordedBlob;
    var nameOk = name.length >= 2 && name.length <= 64;
    registerBtn.disabled = !(nameOk && hasAudio);
  }

  if (speakerNameInput) speakerNameInput.addEventListener('input', updateRegisterBtn);

  // ============ 声纹列表加载 ============
  async function loadList() {
    if (!listBody) return;
    listBody.innerHTML = '<tr><td colspan="4" class="vp-empty">加载中...</td></tr>';
    try {
      var resp = await fetch(apiUrl('/api/voiceprint/list'));
      var data = await resp.json();
      if (!data.success) throw new Error(data.message || '加载失败');
      renderList(data.items || []);
    } catch (err) {
      listBody.innerHTML = '<tr><td colspan="4" class="vp-empty" style="color:#d93025">加载失败: ' + escapeHtml(err.message) + '</td></tr>';
    }
  }

  function renderList(items) {
    if (!listBody) return;
    if (items.length === 0) {
      listBody.innerHTML = '<tr><td colspan="4" class="vp-empty">暂无已注册声纹</td></tr>';
      return;
    }
    var rows = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      rows.push(
        '<tr>' +
          '<td>' + (i + 1) + '</td>' +
          '<td>' + escapeHtml(item.speakerName) + '</td>' +
          '<td style="font-family:monospace;font-size:12px;color:#5f6368">' + escapeHtml(item.speakId) + '</td>' +
          '<td><button class="vp-delete-btn" data-id="' + escapeHtml(item.speakId) + '" data-name="' + escapeHtml(item.speakerName) + '">删除</button></td>' +
        '</tr>'
      );
    }
    listBody.innerHTML = rows.join('');
    var deleteBtns = listBody.querySelectorAll('.vp-delete-btn');
    for (var bi = 0; bi < deleteBtns.length; bi++) {
      (function(btn) {
        btn.addEventListener('click', function() { handleDelete(btn.dataset.id, btn.dataset.name); });
      })(deleteBtns[bi]);
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  if (refreshBtn) refreshBtn.addEventListener('click', loadList);

  // ============ 删除声纹 ============
  async function handleDelete(speakId, speakerName) {
    if (!confirm('确定要删除声纹 "' + speakerName + '" (' + speakId + ') 吗？此操作不可恢复。')) return;
    var btn = listBody ? listBody.querySelector('.vp-delete-btn[data-id="' + speakId + '"]') : null;
    if (btn) btn.disabled = true;
    try {
      var resp = await fetch(apiUrl('/api/voiceprint/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speakId: speakId })
      });
      var data = await resp.json();
      if (!data.success) throw new Error(data.message || '删除失败');
      setStatus('删除成功', 'success');
      loadList();
    } catch (err) {
      setStatus('删除失败: ' + err.message, 'error');
      if (btn) btn.disabled = false;
    }
  }

  // ============ 文件上传 ============
  if (uploadArea) {
    uploadArea.addEventListener('click', function() { if (fileInput) fileInput.click(); });
  }
  if (fileInput) {
    fileInput.addEventListener('change', function(e) {
      var file = e.target.files[0];
      if (file) handleFileSelect(file);
      fileInput.value = '';
    });
  }

  if (uploadArea) {
    uploadArea.addEventListener('dragover', function(e) {
      e.preventDefault();
      uploadArea.classList.add('drag-over');
    });
    uploadArea.addEventListener('dragleave', function() {
      uploadArea.classList.remove('drag-over');
    });
    uploadArea.addEventListener('drop', function(e) {
      e.preventDefault();
      uploadArea.classList.remove('drag-over');
      var file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    });
  }

  if (fileRemoveBtn) {
    fileRemoveBtn.addEventListener('click', function() {
      uploadedFileUrl = null;
      uploadedBlob = null;
      if (fileSelectedDiv) fileSelectedDiv.hidden = true;
      if (previewAudio) {
        previewAudio.style.display = 'none';
        previewAudio.src = '';
      }
      setStatus('', '');
      updateRegisterBtn();
    });
  }

  async function handleFileSelect(file) {
    var allowedExts = ['.wav', '.mp3', '.m4a', '.webm', '.ogg'];
    var ext = '.' + file.name.split('.').pop().toLowerCase();
    if (allowedExts.indexOf(ext) === -1) {
      setStatus('不支持的文件格式，仅支持 .wav .mp3 .m4a .webm .ogg', 'error');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setStatus('文件过大，最大支持 10MB', 'error');
      return;
    }
    uploadedBlob = file;
    if (fileNameSpan) fileNameSpan.textContent = file.name + ' (' + formatSize(file.size) + ')';
    if (fileSelectedDiv) fileSelectedDiv.hidden = false;

    if (previewAudio) {
      var objUrl = URL.createObjectURL(file);
      previewAudio.src = objUrl;
      previewAudio.style.display = 'block';
    }

    setStatus('正在上传文件...', 'loading');
    if (registerBtn) registerBtn.disabled = true;
    try {
      var buffer = await file.arrayBuffer();
      var resp = await fetch(apiUrl('/api/voiceprint/upload'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Ext': ext
        },
        body: buffer
      });
      var data = await resp.json();
      if (!data.success) throw new Error(data.message || '上传失败');
      uploadedFileUrl = data.url;
      setStatus('文件上传成功，可以注册', 'success');
    } catch (err) {
      setStatus('上传失败: ' + err.message, 'error');
      uploadedBlob = null;
      uploadedFileUrl = null;
      if (fileSelectedDiv) fileSelectedDiv.hidden = true;
      if (previewAudio) previewAudio.style.display = 'none';
    }
    updateRegisterBtn();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ============ 现场录音 ============
  if (startRecordBtn) {
    startRecordBtn.addEventListener('click', function() {
      startRecording();
    });
  }

  if (finishBtn) {
    finishBtn.addEventListener('click', function() {
      if (isRecording) stopRecording();
    });
  }

  if (rerecordBtn) {
    rerecordBtn.addEventListener('click', function() {
      if (isRecording) {
        isRecording = false;
        cleanupRecording();
      }
      recordedBuffers = [];
      recordedBlob = null;
      if (previewAudio) {
        previewAudio.style.display = 'none';
        previewAudio.src = '';
      }
      uploadedFileUrl = null;
      resetRecordingUI();
      setStatus('', '');
      updateRegisterBtn();
      startRecording();
    });
  }

  function drawWaveform() {
    if (!analyser || !waveformCanvas) return;
    var canvas = waveformCanvas;
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    var width = rect.width;
    var height = rect.height;

    var bufferLength = analyser.fftSize;
    var dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    ctx.clearRect(0, 0, width, height);

    var grad = ctx.createLinearGradient(0, 0, width, 0);
    grad.addColorStop(0, '#9334e6');
    grad.addColorStop(0.5, '#1a73e8');
    grad.addColorStop(1, '#9334e6');

    ctx.lineWidth = 2;
    ctx.strokeStyle = grad;
    ctx.beginPath();

    var sliceWidth = width * 1.0 / bufferLength;
    var x = 0;
    for (var i = 0; i < bufferLength; i++) {
      var v = dataArray[i] / 128.0;
      var y = v * height / 2;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
      x += sliceWidth;
    }
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    x = 0;
    for (var j = 0; j < bufferLength; j++) {
      var v2 = dataArray[j] / 128.0;
      var y2 = (v2 * height / 2) * 1.3;
      if (j === 0) {
        ctx.moveTo(x, y2);
      } else {
        ctx.lineTo(x, y2);
      }
      x += sliceWidth;
    }
    ctx.lineTo(width, height / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    animationFrameId = requestAnimationFrame(drawWaveform);
  }

  async function startRecording() {
    try {
      setStatus('正在获取麦克风权限...', 'loading');
      if (startRecordBtn) startRecordBtn.disabled = true;
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000
        }
      });

      var AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC({ sampleRate: 16000 });

      sourceNode = audioCtx.createMediaStreamSource(mediaStream);

      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      sourceNode.connect(analyser);

      scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
      recordedBuffers = [];

      scriptNode.onaudioprocess = function(e) {
        if (!isRecording) return;
        var channel = e.inputBuffer.getChannelData(0);
        recordedBuffers.push(new Float32Array(channel));
      };

      sourceNode.connect(scriptNode);
      scriptNode.connect(audioCtx.destination);

      isRecording = true;
      recordStartTime = Date.now();

      if (readGuide) readGuide.hidden = true;
      if (recordingUI) recordingUI.hidden = false;
      if (recordTimer) recordTimer.textContent = '00:00';

      setStatus('正在录音...', 'loading');
      recordedBlob = null;
      if (previewAudio) previewAudio.style.display = 'none';

      drawWaveform();

      timerInterval = setInterval(function() {
        var elapsed = (Date.now() - recordStartTime) / 1000;
        var m = Math.floor(elapsed / 60).toString().padStart(2, '0');
        var s = Math.floor(elapsed % 60).toString().padStart(2, '0');
        if (recordTimer) recordTimer.textContent = m + ':' + s;
        if (elapsed >= 30) stopRecording();
      }, 100);

    } catch (err) {
      if (startRecordBtn) startRecordBtn.disabled = false;
      setStatus('无法访问麦克风: ' + err.message + (err.name === 'NotReadableError' ? '（可能 ASR 正在录音，请先停止 ASR 录音）' : ''), 'error');
      cleanupRecording();
      resetRecordingUI();
    }
  }

  async function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    var duration = (Date.now() - recordStartTime) / 1000;
    if (duration < 1.5) {
      setStatus('录音时间过短（至少需要 1.5 秒），请重试', 'error');
      cleanupRecording();
      recordedBuffers = [];
      resetRecordingUI();
      updateRegisterBtn();
      return;
    }

    setStatus('正在处理录音...', 'loading');

    try {
      var totalLength = 0;
      for (var bi = 0; bi < recordedBuffers.length; bi++) totalLength += recordedBuffers[bi].length;
      var merged = new Float32Array(totalLength);
      var offset = 0;
      for (var bj = 0; bj < recordedBuffers.length; bj++) {
        merged.set(recordedBuffers[bj], offset);
        offset += recordedBuffers[bj].length;
      }

      var pcmBuffer = floatTo16BitPCM(merged);
      var wavBuffer = buildWav(pcmBuffer, 16000, 1, 16);
      recordedBlob = new Blob([wavBuffer], { type: 'audio/wav' });

      if (previewAudio) {
        var objUrl = URL.createObjectURL(recordedBlob);
        previewAudio.src = objUrl;
        previewAudio.style.display = 'block';
      }

      setStatus('录音就绪，可以注册', 'success');

      await uploadRecordedBlob();

    } catch (err) {
      setStatus('录音处理失败: ' + err.message, 'error');
      recordedBlob = null;
    }

    cleanupRecording();
    updateRegisterBtn();
  }

  async function uploadRecordedBlob() {
    if (!recordedBlob) return;
    try {
      var ext = '.wav';
      var buffer = await recordedBlob.arrayBuffer();
      var resp = await fetch(apiUrl('/api/voiceprint/upload'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Ext': ext
        },
        body: buffer
      });
      var data = await resp.json();
      if (!data.success) throw new Error(data.message || '上传失败');
      uploadedFileUrl = data.url;
      setStatus('录音已上传，可以注册', 'success');
    } catch (err) {
      setStatus('录音上传失败: ' + err.message, 'error');
      recordedBlob = null;
      uploadedFileUrl = null;
    }
    updateRegisterBtn();
  }

  function cleanupRecording() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    if (scriptNode) {
      try { scriptNode.disconnect(); } catch(e) {}
      scriptNode.onaudioprocess = null;
      scriptNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch(e) {}
      sourceNode = null;
    }
    if (analyser) {
      try { analyser.disconnect(); } catch(e) {}
      analyser = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch(e) {}
      audioCtx = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function(t) { t.stop(); });
      mediaStream = null;
    }
  }

  function buildWav(pcmData, sampleRate, numChannels, bitsPerSample) {
    var byteRate = sampleRate * numChannels * bitsPerSample / 8;
    var blockAlign = numChannels * bitsPerSample / 8;
    var dataSize = pcmData.length * 2;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    var pcmBytes = new Uint8Array(pcmData.buffer);
    new Uint8Array(buffer, 44).set(pcmBytes);

    return buffer;
  }

  function writeString(view, offset, str) {
    for (var i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  // ============ 注册声纹 ============
  if (registerBtn) {
    registerBtn.addEventListener('click', async function() {
      var name = speakerNameInput ? speakerNameInput.value.trim() : '';
      if (!name || !uploadedFileUrl) return;

      registerBtn.disabled = true;
      setStatus('正在向字节服务端注册声纹...', 'loading');

      try {
        var resp = await fetch(apiUrl('/api/voiceprint/register'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speakerName: name, audioUrl: uploadedFileUrl })
        });
        var data = await resp.json();
        if (!data.success) throw new Error(data.message || '注册失败');

        setStatus('注册成功！SpeakId: ' + data.speakId, 'success');
        loadList();
        if (speakerNameInput) speakerNameInput.value = '';
        uploadedFileUrl = null;
        uploadedBlob = null;
        recordedBlob = null;
        if (fileSelectedDiv) fileSelectedDiv.hidden = true;
        if (previewAudio) {
          previewAudio.style.display = 'none';
          previewAudio.src = '';
        }
        if (sourceRadios.length > 0) {
          sourceRadios[0].checked = true;
          switchSource('upload');
        }

      } catch (err) {
        setStatus('注册失败: ' + err.message, 'error');
        registerBtn.disabled = false;
      }
      updateRegisterBtn();
    });
  }

  // ESC 关闭
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isModalOpen) closeModal();
  });
})();

// ============ 录音文件识别（AUC）功能 ============
(function() {
  function getBasePath() {
    var p = location.pathname;
    if (p.endsWith('/')) return p;
    var idx = p.lastIndexOf('/');
    return idx >= 0 ? p.substring(0, idx + 1) : '/';
  }

  var basePath = getBasePath();
  function apiUrl(path) {
    return basePath + path.replace(/^\//, '');
  }

  var DEFAULT_AUC_CONFIG = {
    modelVersion: '2.0',
    language: '',
    enable_itn: true,
    enable_punc: true,
    enable_ddc: false,
    enable_speaker_info: true,
    ssd_version: '300',
    ssd_mode: 0,
    show_utterances: true,
    end_window_size: 800,
    use_voiceprints: true,
    selected_voiceprint_ids: []
  };

  var aucConfigBtn = document.getElementById('aucConfigBtn');
  var aucTranscribeBtn = document.getElementById('aucTranscribeBtn');
  var aucHint = document.getElementById('aucHint');
  var aucToolbar = document.getElementById('aucToolbar');
  var aucResultsSection = document.getElementById('aucResultsSection');
  var aucResultsList = document.getElementById('aucResultsList');
  var aucConfigModalOverlay = document.getElementById('aucConfigModalOverlay');
  var aucConfigModal = document.getElementById('aucConfigModal');
  var aucModalCloseBtn = document.getElementById('aucModalCloseBtn');
  var aucResetBtn = document.getElementById('aucResetBtn');
  var aucSaveBtn = document.getElementById('aucSaveBtn');
  var aucModelVersionRadios = document.querySelectorAll('input[name="aucModelVersion"]');
  var aucLanguageSelect = document.getElementById('aucLanguage');
  var aucEnableItn = document.getElementById('aucEnableItn');
  var aucEnablePunc = document.getElementById('aucEnablePunc');
  var aucEnableDdc = document.getElementById('aucEnableDdc');
  var aucShowUtterances = document.getElementById('aucShowUtterances');
  var aucEnableSpeaker = document.getElementById('aucEnableSpeaker');
  var aucSpeakerOptions = document.getElementById('aucSpeakerOptions');
  var aucSsdVersionRadios = document.querySelectorAll('input[name="aucSsdVersion"]');
  var aucSsdModeGroup = document.getElementById('aucSsdModeGroup');
  var aucSsdModeRadios = document.querySelectorAll('input[name="aucSsdMode"]');
  var aucEndWindowSize = document.getElementById('aucEndWindowSize');
  var aucEndWindowValue = document.getElementById('aucEndWindowValue');
  var aucUseVoiceprints = document.getElementById('aucUseVoiceprints');
  var aucVoiceprintList = document.getElementById('aucVoiceprintList');

  var isModalOpen = false;
  var pollingTasks = {};

  function openAucConfigModal() {
    if (isModalOpen) return;
    isModalOpen = true;
    aucConfigModalOverlay.hidden = false;
    document.body.style.overflow = 'hidden';
    loadAucConfig();
    loadVoiceprintList();
  }

  function closeAucConfigModal() {
    if (!isModalOpen) return;
    isModalOpen = false;
    aucConfigModalOverlay.hidden = true;
    document.body.style.overflow = '';
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function loadAucConfig() {
    fetch(apiUrl('/api/auc/config'))
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.success) {
          fillConfigForm(data.config);
        } else {
          fillConfigForm(DEFAULT_AUC_CONFIG);
        }
      })
      .catch(function() {
        fillConfigForm(DEFAULT_AUC_CONFIG);
      });
  }

  function fillConfigForm(config) {
    var cfg = config || DEFAULT_AUC_CONFIG;
    for (var i = 0; i < aucModelVersionRadios.length; i++) {
      if (aucModelVersionRadios[i].value === cfg.modelVersion) {
        aucModelVersionRadios[i].checked = true;
        break;
      }
    }
    if (aucLanguageSelect) aucLanguageSelect.value = cfg.language || '';
    if (aucEnableItn) aucEnableItn.checked = !!cfg.enable_itn;
    if (aucEnablePunc) aucEnablePunc.checked = !!cfg.enable_punc;
    if (aucEnableDdc) aucEnableDdc.checked = !!cfg.enable_ddc;
    if (aucShowUtterances) aucShowUtterances.checked = !!cfg.show_utterances;
    if (aucEnableSpeaker) aucEnableSpeaker.checked = !!cfg.enable_speaker_info;
    updateSpeakerOptionsVisibility();
    for (var j = 0; j < aucSsdVersionRadios.length; j++) {
      if (aucSsdVersionRadios[j].value === String(cfg.ssd_version)) {
        aucSsdVersionRadios[j].checked = true;
        break;
      }
    }
    updateSsdModeVisibility();
    for (var k = 0; k < aucSsdModeRadios.length; k++) {
      if (parseInt(aucSsdModeRadios[k].value, 10) === cfg.ssd_mode) {
        aucSsdModeRadios[k].checked = true;
        break;
      }
    }
    if (aucEndWindowSize) aucEndWindowSize.value = cfg.end_window_size || 800;
    updateEndWindowValue();
    if (aucUseVoiceprints) aucUseVoiceprints.checked = !!cfg.use_voiceprints;
    window.__aucSelectedVoiceprintIds = cfg.selected_voiceprint_ids || [];
  }

  function loadVoiceprintList() {
    fetch(apiUrl('/api/voiceprint/list'))
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.success) {
          renderVoiceprintList(data.items || []);
        } else {
          aucVoiceprintList.innerHTML = '<span style="color:#d93025">加载声纹列表失败</span>';
        }
      })
      .catch(function() {
        aucVoiceprintList.innerHTML = '<span style="color:#d93025">加载声纹列表失败</span>';
      });
  }

  function renderVoiceprintList(items) {
    if (!aucVoiceprintList) return;
    aucVoiceprintList.innerHTML = '';
    if (items.length === 0) {
      aucVoiceprintList.innerHTML = '<span style="color:#5f6368;font-size:13px">暂无已注册声纹</span>';
      return;
    }
    var selectedIds = window.__aucSelectedVoiceprintIds || [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var label = document.createElement('label');
      label.className = 'auc-checkbox';
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.value = item.speakId;
      if (selectedIds.indexOf(item.speakId) !== -1) {
        input.checked = true;
      }
      var span = document.createElement('span');
      span.textContent = item.speakerName;
      label.appendChild(input);
      label.appendChild(span);
      aucVoiceprintList.appendChild(label);
    }
  }

  function updateSpeakerOptionsVisibility() {
    if (!aucSpeakerOptions || !aucEnableSpeaker) return;
    aucSpeakerOptions.style.display = aucEnableSpeaker.checked ? '' : 'none';
  }

  function updateSsdModeVisibility() {
    if (!aucSsdModeGroup) return;
    var selectedSsdVersion = null;
    for (var i = 0; i < aucSsdVersionRadios.length; i++) {
      if (aucSsdVersionRadios[i].checked) {
        selectedSsdVersion = aucSsdVersionRadios[i].value;
        break;
      }
    }
    aucSsdModeGroup.style.display = selectedSsdVersion === '200' ? '' : 'none';
  }

  function updateEndWindowValue() {
    if (!aucEndWindowValue || !aucEndWindowSize) return;
    aucEndWindowValue.textContent = aucEndWindowSize.value + ' ms';
  }

  function collectFormValues() {
    var modelVersion = '2.0';
    for (var i = 0; i < aucModelVersionRadios.length; i++) {
      if (aucModelVersionRadios[i].checked) {
        modelVersion = aucModelVersionRadios[i].value;
        break;
      }
    }
    var ssdVersion = '300';
    for (var j = 0; j < aucSsdVersionRadios.length; j++) {
      if (aucSsdVersionRadios[j].checked) {
        ssdVersion = aucSsdVersionRadios[j].value;
        break;
      }
    }
    var ssdMode = 0;
    for (var k = 0; k < aucSsdModeRadios.length; k++) {
      if (aucSsdModeRadios[k].checked) {
        ssdMode = parseInt(aucSsdModeRadios[k].value, 10);
        break;
      }
    }
    var selectedVoiceprintIds = [];
    if (aucVoiceprintList) {
      var checkboxes = aucVoiceprintList.querySelectorAll('input[type="checkbox"]:checked');
      for (var ci = 0; ci < checkboxes.length; ci++) {
        selectedVoiceprintIds.push(checkboxes[ci].value);
      }
    }
    return {
      modelVersion: modelVersion,
      language: aucLanguageSelect ? aucLanguageSelect.value : '',
      enable_itn: aucEnableItn ? aucEnableItn.checked : true,
      enable_punc: aucEnablePunc ? aucEnablePunc.checked : true,
      enable_ddc: aucEnableDdc ? aucEnableDdc.checked : false,
      enable_speaker_info: aucEnableSpeaker ? aucEnableSpeaker.checked : true,
      ssd_version: ssdVersion,
      ssd_mode: ssdMode,
      show_utterances: aucShowUtterances ? aucShowUtterances.checked : true,
      end_window_size: aucEndWindowSize ? parseInt(aucEndWindowSize.value, 10) : 800,
      use_voiceprints: aucUseVoiceprints ? aucUseVoiceprints.checked : true,
      selected_voiceprint_ids: selectedVoiceprintIds
    };
  }

  function saveAucConfig() {
    var config = collectFormValues();
    fetch(apiUrl('/api/auc/config'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: config })
    })
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.success) {
          closeAucConfigModal();
        } else {
          alert('保存配置失败：' + (data.message || '未知错误'));
        }
      })
      .catch(function(err) {
        alert('保存配置失败：' + err.message);
      });
  }

  function resetAucConfig() {
    fillConfigForm(DEFAULT_AUC_CONFIG);
  }

  function formatTime(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function previewTranscript(url) {
    var fullUrl = url;
    if (fullUrl.charAt(0) === '/') {
      fullUrl = basePath + fullUrl.substring(1);
    }
    window.open(fullUrl, '_blank');
  }

  function addResultItem(task) {
    if (!aucResultsList) return null;
    var placeholder = aucResultsList.querySelector('.placeholder');
    if (placeholder) placeholder.remove();
    var item = document.createElement('div');
    item.className = 'auc-result-item';
    item.dataset.taskId = task.taskId;
    aucResultsList.insertBefore(item, aucResultsList.firstChild);
    updateResultItem(item, task);
    if (aucResultsSection) aucResultsSection.hidden = false;
    return item;
  }

  function updateResultItem(itemEl, task) {
    if (!itemEl) return;
    itemEl.innerHTML = '';
    itemEl.className = 'auc-result-item';

    var statusClass = '';
    var statusText = '';
    switch (task.status) {
      case 'queued':
        statusText = '排队中';
        statusClass = 'auc-status-queued';
        break;
      case 'processing':
        statusText = '识别中';
        statusClass = 'auc-status-processing';
        break;
      case 'completed':
        statusText = '已完成';
        statusClass = 'auc-status-completed';
        break;
      case 'failed':
        statusText = '失败';
        statusClass = 'auc-status-failed';
        break;
    }
    itemEl.classList.add(statusClass);

    var statusDiv = document.createElement('div');
    statusDiv.className = 'auc-result-status';

    if (task.status === 'queued' || task.status === 'processing') {
      var spinner = document.createElement('span');
      spinner.className = 'spinner';
      statusDiv.appendChild(spinner);
    }

    var statusSpan = document.createElement('span');
    statusSpan.textContent = statusText;
    statusDiv.appendChild(statusSpan);
    itemEl.appendChild(statusDiv);

    var infoDiv = document.createElement('div');
    infoDiv.className = 'auc-result-info';

    var metaLine = document.createElement('div');
    var hasMeta = false;
    if (task.createdAt) {
      var timeSpan = document.createElement('span');
      timeSpan.className = 'auc-result-time';
      timeSpan.textContent = formatTime(task.createdAt);
      metaLine.appendChild(timeSpan);
      hasMeta = true;
    }
    if (task.duration) {
      var durSpan = document.createElement('span');
      durSpan.className = 'auc-result-duration';
      durSpan.textContent = (task.duration / 1000).toFixed(1) + 's';
      metaLine.appendChild(durSpan);
      hasMeta = true;
    }
    if (hasMeta) {
      infoDiv.appendChild(metaLine);
    }

    if (task.status === 'failed' && task.error) {
      var errDiv = document.createElement('div');
      errDiv.className = 'auc-result-error';
      errDiv.textContent = task.error;
      infoDiv.appendChild(errDiv);
    }

    itemEl.appendChild(infoDiv);

    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'auc-result-actions';

    if (task.status === 'completed' && task.transcriptUrl) {
      var previewBtn = document.createElement('button');
      previewBtn.className = 'auc-result-preview';
      previewBtn.textContent = '查看转写';
      previewBtn.addEventListener('click', function() {
        previewTranscript(task.transcriptUrl);
      });
      actionsDiv.appendChild(previewBtn);
    }

    if (task.status === 'failed') {
      var retryBtn = document.createElement('button');
      retryBtn.className = 'auc-result-retry';
      retryBtn.textContent = '重试';
      retryBtn.addEventListener('click', function() {
        retryTranscribe(task.recordingUrl);
      });
      actionsDiv.appendChild(retryBtn);
    }

    itemEl.appendChild(actionsDiv);
  }

  function findResultItem(taskId) {
    if (!aucResultsList) return null;
    return aucResultsList.querySelector('.auc-result-item[data-task-id="' + taskId + '"]');
  }

  function startTranscription() {
    var recordingUrl = window.__currentRecordingUrl;
    if (!recordingUrl) {
      alert('没有可用的录音文件');
      return;
    }
    if (aucTranscribeBtn) aucTranscribeBtn.disabled = true;
    if (aucHint) aucHint.textContent = '正在提交转写任务...';

    fetch(apiUrl('/api/auc/submit'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingUrl: recordingUrl })
    })
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.success) {
          var task = {
            taskId: data.taskId,
            status: 'queued',
            recordingUrl: recordingUrl,
            createdAt: Date.now()
          };
          addResultItem(task);
          if (aucHint) aucHint.textContent = '任务已提交，等待处理...';
          pollTaskStatus(data.taskId);
        } else {
          if (aucTranscribeBtn) aucTranscribeBtn.disabled = false;
          if (aucHint) aucHint.textContent = '提交失败：' + (data.message || '未知错误');
          alert('提交失败：' + (data.message || '未知错误'));
        }
      })
      .catch(function(err) {
        if (aucTranscribeBtn) aucTranscribeBtn.disabled = false;
        if (aucHint) aucHint.textContent = '提交失败：' + err.message;
        alert('提交失败：' + err.message);
      });
  }

  function pollTaskStatus(taskId) {
    if (pollingTasks[taskId]) return;

    function doPoll() {
      fetch(apiUrl('/api/auc/query?taskId=' + encodeURIComponent(taskId)))
        .then(function(resp) { return resp.json(); })
        .then(function(data) {
          if (data.success) {
            var itemEl = findResultItem(taskId);
            updateResultItem(itemEl, data);

            if (data.status === 'completed' || data.status === 'failed') {
              delete pollingTasks[taskId];
              if (aucTranscribeBtn) aucTranscribeBtn.disabled = false;
              if (aucHint) {
                if (data.status === 'completed') {
                  aucHint.textContent = '转写完成';
                } else {
                  aucHint.textContent = '转写失败';
                }
              }
            } else {
              pollingTasks[taskId] = setTimeout(doPoll, 3000);
            }
          } else {
            delete pollingTasks[taskId];
            if (aucTranscribeBtn) aucTranscribeBtn.disabled = false;
          }
        })
        .catch(function() {
          delete pollingTasks[taskId];
          if (aucTranscribeBtn) aucTranscribeBtn.disabled = false;
        });
    }

    doPoll();
  }

  function retryTranscribe(recordingUrl) {
    window.__currentRecordingUrl = recordingUrl;
    startTranscription();
  }

  function loadHistoryTasks() {
    fetch(apiUrl('/api/auc/list'))
      .then(function(resp) { return resp.json(); })
      .then(function(data) {
        if (data.success && Array.isArray(data.tasks)) {
          var tasks = data.tasks.slice(0, 20);
          if (tasks.length > 0 && aucResultsList) {
            aucResultsList.innerHTML = '';
            for (var i = 0; i < tasks.length; i++) {
              addResultItem(tasks[i]);
              if (tasks[i].status === 'queued' || tasks[i].status === 'processing') {
                pollTaskStatus(tasks[i].taskId);
              }
            }
          }
        }
      })
      .catch(function() {});
  }

  if (aucConfigBtn) aucConfigBtn.addEventListener('click', openAucConfigModal);
  if (aucModalCloseBtn) aucModalCloseBtn.addEventListener('click', closeAucConfigModal);
  if (aucResetBtn) aucResetBtn.addEventListener('click', resetAucConfig);
  if (aucSaveBtn) aucSaveBtn.addEventListener('click', saveAucConfig);
  if (aucTranscribeBtn) aucTranscribeBtn.addEventListener('click', startTranscription);

  if (aucConfigModalOverlay) {
    aucConfigModalOverlay.addEventListener('click', function(e) {
      if (e.target === aucConfigModalOverlay) closeAucConfigModal();
    });
  }

  if (aucEnableSpeaker) {
    aucEnableSpeaker.addEventListener('change', updateSpeakerOptionsVisibility);
  }

  for (var i = 0; i < aucSsdVersionRadios.length; i++) {
    aucSsdVersionRadios[i].addEventListener('change', updateSsdModeVisibility);
  }

  if (aucEndWindowSize) {
    aucEndWindowSize.addEventListener('input', updateEndWindowValue);
  }

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && isModalOpen) closeAucConfigModal();
  });

  updateSpeakerOptionsVisibility();
  updateSsdModeVisibility();
  updateEndWindowValue();
  loadHistoryTasks();
})();
