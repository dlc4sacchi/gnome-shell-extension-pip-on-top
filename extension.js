/*
 * GNOME Shell Extension: PiP on top
 * Developer: Rafostar
 */

import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class PipOnTop extends Extension
{
  enable()
  {
    this._lastWorkspace = null;
    this._lastPipPosition = null;
    this._windowAddedId = 0;
    this._windowRemovedId = 0;

    this.settings = this.getSettings();
    this._settingsChangedId = this.settings.connect(
      'changed', this._onSettingsChanged.bind(this));

    this._switchWorkspaceId = global.window_manager.connect_after(
      'switch-workspace', this._onSwitchWorkspace.bind(this));
    this._onSwitchWorkspace();
  }

  disable()
  {
    this.settings.disconnect(this._settingsChangedId);
    this.settings = null;

    global.window_manager.disconnect(this._switchWorkspaceId);

    if (this._lastWorkspace) {
      this._lastWorkspace.disconnect(this._windowAddedId);
      this._lastWorkspace.disconnect(this._windowRemovedId);
    }

    this._lastWorkspace = null;
    this._settingsChangedId = 0;
    this._switchWorkspaceId = 0;
    this._windowAddedId = 0;
    this._windowRemovedId = 0;

    let actors = global.get_window_actors();
    if (actors) {
      for (let actor of actors) {
        let window = actor.meta_window;
        if (!window) continue;

        if (window._isPipAble) {
          if (window.above)
            window.unmake_above();
          if (window.on_all_workspaces)
            window.unstick();
        }

        this._onWindowRemoved(null, window);
      }
    }

    this._lastPipPosition = null;
  }

  _onSettingsChanged(settings, key)
  {
    switch (key) {
      case 'stick':
        /* Updates already present windows */
        this._onSwitchWorkspace();
        break;
      case 'remember-position':
        if (!this.settings.get_boolean('remember-position')) {
          let actors = global.get_window_actors();
          if (actors) {
            for (let actor of actors) {
              let window = actor.meta_window;
              if (!window) continue;
              this._disconnectPositionSignals(window);
            }
          }
        } else {
          let actors = global.get_window_actors();
          if (actors) {
            for (let actor of actors) {
              let window = actor.meta_window;
              if (!window) continue;
              if (window._isPipAble)
                this._connectPositionSignals(window);
            }
          }
        }
        break;
      default:
        break;
    }
  }

  _onSwitchWorkspace()
  {
    let workspace = global.workspace_manager.get_active_workspace();
    let wsWindows = global.display.get_tab_list(Meta.TabList.NORMAL, workspace);

    if (this._lastWorkspace) {
      this._lastWorkspace.disconnect(this._windowAddedId);
      this._lastWorkspace.disconnect(this._windowRemovedId);
    }

    this._lastWorkspace = workspace;
    this._windowAddedId = this._lastWorkspace.connect(
      'window-added', this._onWindowAdded.bind(this));
    this._windowRemovedId = this._lastWorkspace.connect(
      'window-removed', this._onWindowRemoved.bind(this));

    /* Update state on already present windows */
    if (wsWindows) {
      for (let window of wsWindows)
        this._onWindowAdded(workspace, window);
    }
  }

  _onWindowAdded(workspace, window)
  {
    if (!window._notifyPipTitleId) {
      window._notifyPipTitleId = window.connect_after(
        'notify::title', this._checkTitle.bind(this));
    }
    this._checkTitle(window);
  }

  _onWindowRemoved(workspace, window)
  {
    if (window._notifyPipTitleId) {
      window.disconnect(window._notifyPipTitleId);
      window._notifyPipTitleId = null;
    }
    if (this.settings && this.settings.get_boolean('remember-position'))
      this._storeWindowPosition(window);

    this._disconnectPositionSignals(window);

    if (window._isPipAble)
      window._isPipAble = null;
  }

  _checkTitle(window)
  {
    if (!window.title)
      return;

    /* Check both translated and untranslated string for
     * users that prefer running applications in English */
    let isPipWin = (window.title == 'Picture-in-Picture'
      || window.title == _('Picture-in-Picture')
      || window.title == 'Picture in picture'
      || window.title == 'Picture-in-picture'
      || window.title.endsWith(' - PiP')
      /* Telegram support */
      || window.title == 'TelegramDesktop'
      /* Yandex.Browser support YouTube */
      || window.title.endsWith(' - YouTube'));

    if (isPipWin || window._isPipAble) {
      let un = (isPipWin) ? '' : 'un';

      window._isPipAble = true;
      window[`${un}make_above`]();

      /* Change stick if enabled or unstick PipAble windows */
      un = (isPipWin && this.settings.get_boolean('stick')) ? '' : 'un';
      window[`${un}stick`]();

      if (this.settings.get_boolean('remember-position')) {
        this._connectPositionSignals(window);
        if (isPipWin)
          this._maybeRestoreWindowPosition(window);
      }
    }
  }

  _connectPositionSignals(window)
  {
    if (!window) return;
    if (window._pipSizeChangedId || window._pipPosChangedId) return;

    try {
      window._pipSizeChangedId = window.connect('size-changed', () => {
        this._queueStoreWindowPosition(window);
      });
    } catch (e) {
      window._pipSizeChangedId = null;
    }

    try {
      window._pipPosChangedId = window.connect('position-changed', () => {
        this._queueStoreWindowPosition(window);
      });
    } catch (e) {
      window._pipPosChangedId = null;
    }
  }

  _disconnectPositionSignals(window)
  {
    if (!window) return;

    if (window._pipStoreDebounceId) {
      GLib.source_remove(window._pipStoreDebounceId);
      window._pipStoreDebounceId = 0;
    }

    if (window._pipRestoreTimeoutIds && window._pipRestoreTimeoutIds.length) {
      for (let id of window._pipRestoreTimeoutIds)
        GLib.source_remove(id);
    }
    window._pipRestoreTimeoutIds = null;

    if (window._pipSizeChangedId) {
      window.disconnect(window._pipSizeChangedId);
      window._pipSizeChangedId = 0;
    }
    if (window._pipPosChangedId) {
      window.disconnect(window._pipPosChangedId);
      window._pipPosChangedId = 0;
    }
  }

  _queueStoreWindowPosition(window)
  {
    if (!this.settings || !this.settings.get_boolean('remember-position'))
      return;

    if (window._pipStoreDebounceId) {
      GLib.source_remove(window._pipStoreDebounceId);
      window._pipStoreDebounceId = 0;
    }

    window._pipStoreDebounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
      this._storeWindowPosition(window);
      window._pipStoreDebounceId = 0;
      return GLib.SOURCE_REMOVE;
    });
  }

  _storeWindowPosition(window)
  {
    if (!window) return;
    let rect = window.get_frame_rect();
    if (!rect) return;
    if (rect.width > 0 && rect.height > 0 && rect.x > 0 && rect.y > 0) {
      this._lastPipPosition = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      log('pip-on-top: stored PiP position ' + JSON.stringify(this._lastPipPosition));
    }
  }

  _maybeRestoreWindowPosition(window)
  {
    if (!this._lastPipPosition) return;
    let pos = this._lastPipPosition;
    if (!(pos.x > 0 && pos.y > 0 && pos.width > 0 && pos.height > 0)) return;

    let ws = window.get_workspace();
    if (ws)
      ws.activate(global.get_current_time());

    window.move_frame(true, pos.x, pos.y);
    log('pip-on-top: restore attempt at ' + pos.x + ',' + pos.y);

    window._pipRestoreTimeoutIds = [];
    for (let i = 1; i <= 2; i++) {
      let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500 * i, () => {
        let ws2 = window.get_workspace();
        if (ws2)
          ws2.activate(global.get_current_time());
        window.move_frame(true, pos.x, pos.y);
        log('pip-on-top: restore retry ' + i + ' at ' + pos.x + ',' + pos.y);
        return GLib.SOURCE_REMOVE;
      });
      window._pipRestoreTimeoutIds.push(id);
    }
  }
}
