"use strict";

class PopupText {
  constructor(options) {
    this.options = options;
    this.init = false;
    this.triggers = [];
    this.timers = [];

    this.kMaxRowsOfText = 2;
  }

  SetTimelineLoader(timelineLoader) {
    this.timelineLoader = timelineLoader;
  }

  OnPlayerChange(e) {
    if (!this.init) {
      this.init = true;
      this.infoText = document.getElementById('popup-text-info');
      this.alertText = document.getElementById('popup-text-alert');
      this.alarmText = document.getElementById('popup-text-alarm');
    }

    if (this.job != e.detail.job || this.me != e.detail.name)
      this.OnJobChange(e);
  }

  OnDataFilesRead(e) {
    this.triggerSets = Options.Triggers;
    for (var filename in e.detail.files) {
      // Reads from the data/triggers/ directory.
      if (!filename.startsWith('triggers/'))
        continue;

      var text = e.detail.files[filename];
      var json;
      try {
        json = eval(text);
      } catch (exception) {
        console.log('Error parsing JSON from ' + filename + ': ' + exception);
        continue;
      }
      if (typeof json != "object" || !(json.length >= 0)) {
        console.log('Unexpected JSON from ' + filename + ', expected an array');
        continue;
      }
      for (var i = 0; i < json.length; ++i) {
        if (!('zoneRegex' in json[i])) {
          console.log('Unexpected JSON from ' + filename + ', expected a zoneRegex');
          continue;
        }
        if (!('triggers' in json[i])) {
          console.log('Unexpected JSON from ' + filename + ', expected a triggers');
          continue;
        }
        if (typeof json[i].triggers != 'object' || !(json[i].triggers.length >= 0)) {
          console.log('Unexpected JSON from ' + filename + ', expected triggers to be an array');
          continue;
        }
      }
      Array.prototype.push.apply(this.triggerSets, json);
    }
  }

  OnZoneChange(e) {
    this.zoneName = e.detail.zoneName;
    this.ReloadTimelines();
  }

  ReloadTimelines() {
    // Datafiles, job, and zone must be loaded.
    if (!this.triggerSets || !this.me || !this.zoneName)
      return;

    this.Reset();

    // Drop the triggers and timelines from the previous zone, so we can add new ones.
    this.triggers = [];
    var timelineFiles = [];
    var timelines = [];

    // Recursively/iteratively process timeline entries for triggers.
    // Functions get called with data, arrays get iterated, strings get appended.
    var addTimeline = (function(obj) {
      if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; ++i)
          addTimeline(obj[i]);
      } else if (typeof(obj) == 'function') {
        addTimeline(obj(this.data));
      } else if (obj) {
        timelines.push(obj);
      }
    }).bind(this);

    for (var i = 0; i < this.triggerSets.length; ++i) {
      var set = this.triggerSets[i];
      if (this.zoneName.search(set.zoneRegex) >= 0) {
        // Save the triggers from each set that matches.
        Array.prototype.push.apply(this.triggers, set.triggers);
        // And set the timeline files/timelines from each set that matches.
        if (set.timelineFile)
          timelineFiles.push(set.timelineFile);
        if (set.timeline)
          addTimeline(set.timeline);
      }
    }

    this.timelineLoader.SetTimelines(timelineFiles, timelines);
  }

  OnJobChange(e) {
    this.me = e.detail.name;
    this.job = e.detail.job;
    if (this.job.search(/^(WAR|DRK|PLD|MRD|GLD)$/) >= 0)
      this.role = 'tank';
    else if (this.job.search(/^(WHM|SCH|AST|CNJ)$/) >= 0)
      this.role = 'healer';
    else if (this.job.search(/^(MNK|NIN|DRG|SAM|ROG|LNC|PUG)$/) >= 0)
      this.role = 'dps-melee';
    else if (this.job.search(/^(BLM|SMN|RDM|THM|ACN)$/) >= 0)
      this.role = 'dps-caster';
    else if (this.job.search(/^(BRD|MCH|ARC)$/) >= 0)
      this.role = 'dps-ranged';
    else if (this.job.search(/^(CRP|BSM|ARM|GSM|LTW|WVR|ALC|CUL)$/) >= 0)
      this.role = 'crafting';
    else if (this.job.search(/^(MIN|BOT|FSH)$/) >= 0)
      this.role = 'gathering';
    else {
      this.role = '';
      console.log("Unknown job role")
    }

    this.ReloadTimelines();
  }

  OnInCombat(e) {
    // If we're in a boss fight and combat ends, ignore that.
    // Otherwise consider it a fight reset.
    if (!e.detail.inCombat && !this.inBossFight)
      this.Reset();
  }

  OnBossFightStart(e) {
    this.inBossFight = true;
  }

  OnBossFightEnd(e) {
    this.inBossFight = false;
    this.Reset();
  }

  Reset() {
    this.data = {
      me: this.me,
      job: this.job,
      role: this.role,
      ParseLocaleFloat: function(s) { return Regexes.ParseLocaleFloat(s); },
    };
    for (var i = 0; i < this.timers.length; ++i)
      window.clearTimeout(this.timers[i]);
    this.timers = [];
  }

  OnLog(e) {
    if (!this.init)
      return;

    for (var i = 0; i < e.detail.logs.length; i++) {
      var log = e.detail.logs[i];

      for (var j = 0; j < this.triggers.length; ++j) {
        var trigger = this.triggers[j];
        var r = log.match(Regexes.Parse(trigger.regex));
        if (r != null)
          this.OnTrigger(trigger, r);
      }
    }
  }

  OnTrigger(trigger, matches) {
    if (!this.options.AlertsEnabled)
      return;
    if ('disabled' in trigger && trigger.disabled)
      return;
    if ('condition' in trigger) {
      if (!trigger.condition(this.data, matches))
        return;
    }

    var that = this;
    var ValueOrFunction = function(f) {
      return (typeof(f) == "function") ? f(that.data, matches) : f;
    }

    var showText = this.options.TextAlertsEnabled;
    var playSounds = this.options.SoundAlertsEnabled;
    var playSpeech = this.options.SpokenAlertsEnabled;
    var userDisabled = trigger.id && this.options.DisabledTriggers[trigger.id];
    var delay = 'delaySeconds' in trigger ? ValueOrFunction(trigger.delaySeconds) : 0;
    var duration = 'durationSeconds' in trigger ? ValueOrFunction(trigger.durationSeconds) : 3;

    var triggerOptions = trigger.id && this.options.PerTriggerOptions[trigger.id];
    if (triggerOptions) {
      if ('SpeechAlert' in triggerOptions)
        playSpeech = triggerOptions.SpeechAlert;
      if ('SoundAlert' in triggerOptions)
        playSounds = triggerOptions.SoundAlert;
      if ('TextAlert' in triggerOptions)
        showText = triggerOptions.TextAlert;
    }

    var f = function() {
      var soundUrl = '';
      var soundVol = 1;
      var ttsText = '';

      var addText = function(container, e) {
        container.appendChild(e);
        if (container.children.length > this.kMaxRowsOfText)
          container.removeChild(container.children[0]);
      }
      var removeText = function(container, e) {
        for (var i = 0; i < container.children.length; ++i) {
          if (container.children[i] == e) {
            container.removeChild(e);
            break;
          }
        }
      }
      var makeTextElement = function(text, className) {
        var div = document.createElement('div');
        div.classList.add(className);
        div.classList.add('animate-text');
        div.innerText = text;
        return div;
      }

      if ('infoText' in trigger) {
        var text = ValueOrFunction(trigger.infoText);
        if (text && !userDisabled && showText) {
          var holder = that.infoText.getElementsByClassName('holder')[0];
          var div = makeTextElement(text, 'info-text');
          addText.bind(that)(holder, div);
          window.setTimeout(removeText.bind(that, holder, div), duration * 1000);

          if (!('sound' in trigger)) {
            soundUrl = that.options.InfoSound;
            soundVol = that.options.InfoSoundVolume;
          }
        }
      }
      if ('alertText' in trigger) {
        var text = ValueOrFunction(trigger.alertText);
        if (text && !userDisabled && showText) {
          var holder = that.alertText.getElementsByClassName('holder')[0];
          var div = makeTextElement(text, 'alert-text');
          addText.bind(that)(holder, div);
          window.setTimeout(removeText.bind(that, holder, div), duration * 1000);

          if (!('sound' in trigger)) {
            soundUrl = that.options.AlertSound;
            soundVol = that.options.AlertSoundVolume;
          }
        }
      }
      if ('alarmText' in trigger) {
        var text = ValueOrFunction(trigger.alarmText);
        if (text && !userDisabled && showText) {
          var holder = that.alarmText.getElementsByClassName('holder')[0];
          var div = makeTextElement(text, 'alarm-text');
          addText.bind(that)(holder, div);
          window.setTimeout(removeText.bind(that, holder, div), duration * 1000);

          if (!('sound' in trigger)) {
            soundUrl = that.options.AlarmSound;
            soundVol = that.options.AlarmSoundVolume;
          }
        }
      }
      if ('tts' in trigger && playSpeech) {
        var text = ValueOrFunction(trigger.tts);
        if (text && !userDisabled)
          ttsText = text;
      }

      if (trigger.sound) {
        soundUrl = trigger.sound;

        var namedSound = trigger.sound + 'Sound';
        var namedSoundVolume = trigger.sound + 'SoundVolume';
        if (namedSound in that.options) {
          soundUrl = that.options[namedSound];
          if (namedSoundVolume in that.options)
            volume = that.options[namedSoundVolume];
        }
        if ('soundVolume' in trigger)
          soundVol = trigger.soundVolume;
      }

      if (triggerOptions) {
        soundUrl = triggerOptions.SoundOverride || soundUrl;
        soundVol = triggerOptions.VolumeOverride || soundVol;
      }

      // Text to speech overrides all other sounds.  This is so
      // that a user who prefers tts can still get the benefit
      // of infoText triggers without tts entries by turning
      // on (speech=true, text=true, sound=true) but this will
      // not cause tts to play over top of sounds or noises.
      if (soundUrl && playSounds && !userDisabled && !ttsText) {
        var audio = new Audio(soundUrl);
        audio.volume = soundVol;
        audio.play();
      }

      if (ttsText && !userDisabled) {
        var cmd = { 'say': ttsText };
        OverlayPluginApi.overlayMessage(OverlayPluginApi.overlayName, JSON.stringify(cmd));
      }

      if ('run' in trigger)
        trigger.run(that.data, matches);
    };
    if (!delay)
      f();
    else
      this.timers.push(window.setTimeout(f, delay * 1000));
  }

  Test(zone, log) {
    this.OnPlayerChange({ detail: { name : 'ME' } });
    this.OnZoneChange({ detail: { zoneName: zone } });
    this.OnLog({ detail: { logs : ['abcdefgh', log, 'hgfedcba']}});
  }
};

class PopupTextGenerator {
  constructor(popupText) { this.popupText = popupText; }

  Info(text) {
    this.popupText.OnTrigger({
      infoText: text,
    });
  }

  Alert(text) {
    this.popupText.OnTrigger({
      alertText: text,
    });
  }

  Alarm(text) {
    this.popupText.OnTrigger({
      alarmText: text,
    });
  }

}

var gPopupText;

document.addEventListener("onPlayerChangedEvent", function(e) {
  gPopupText.OnPlayerChange(e);
});
document.addEventListener("onZoneChangedEvent", function(e) {
  gPopupText.OnZoneChange(e);
});
document.addEventListener("onInCombatChangedEvent", function (e) {
  gPopupText.OnInCombat(e);
});
document.addEventListener("onBossFightStart", function(e) {
  gPopupText.OnBossFightStart(e);
});
document.addEventListener("onBossFightEnd", function(e) {
  gPopupText.OnBossFightEnd(e);
});
document.addEventListener("onLogEvent", function(e) {
  gPopupText.OnLog(e);
});
document.addEventListener("onDataFilesRead", function(e) {
  gPopupText.OnDataFilesRead(e);
});
