// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { IClientSession, ICommandPalette } from '@jupyterlab/apputils';

import { IEditorServices } from '@jupyterlab/codeeditor';

import { ConsolePanel, IConsoleTracker } from '@jupyterlab/console';

import { IStateDB } from '@jupyterlab/coreutils';

import { DocumentWidget } from '@jupyterlab/docregistry';

import { FileEditor, IEditorTracker } from '@jupyterlab/fileeditor';

import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';

import { Session } from '@jupyterlab/services';

import { Debugger } from './debugger';

import { ConsoleHandler } from './handlers/console';

import { FileHandler } from './handlers/file';

import { NotebookHandler } from './handlers/notebook';

import { TrackerHandler } from './handlers/tracker';

import { DebugService } from './service';

import { DebugSession } from './session';

import { IDebugger } from './tokens';

/**
 * The command IDs used by the debugger plugin.
 */
export namespace CommandIDs {
  export const create = 'debugger:create';

  export const start = 'debugger:start';

  export const stop = 'debugger:stop';

  export const debugContinue = 'debugger:continue';

  export const terminate = 'debugger:terminate';

  export const next = 'debugger:next';

  export const stepIn = 'debugger:stepIn';

  export const stepOut = 'debugger:stepOut';

  export const debugConsole = 'debugger:debug-console';

  export const mount = 'debugger:mount';

  export const closeDebugger = 'debugger:close';
}

async function setDebugSession(
  app: JupyterFrontEnd,
  debug: IDebugger,
  client: IClientSession | Session.ISession
) {
  if (!debug.session) {
    debug.session = new DebugSession({ client: client });
  } else {
    debug.session.client = client;
  }
  await debug.restoreState(true);
  app.commands.notifyCommandChanged();
}

class DebuggerHandler<
  H extends ConsoleHandler | NotebookHandler | FileHandler
> {
  constructor(builder: new (option: any) => H) {
    this.builder = builder;
  }

  update<W extends ConsolePanel | NotebookPanel | FileEditor>(
    debug: IDebugger,
    widget: W
  ): void {
    if (!debug.model || this.handlers[widget.id] || !debug.isDebuggingEnabled) {
      return;
    }
    const handler = new this.builder({
      debuggerService: debug,
      widget
    });
    widget.node.setAttribute('data-jp-debugger', 'true');
    this.handlers[widget.id] = handler;
    widget.disposed.connect(() => {
      handler.dispose();
      delete this.handlers[widget.id];
    });

    debug.model.disposed.connect(async () => {
      const handlerIds = Object.keys(this.handlers);
      if (handlerIds.length === 0) {
        return;
      }
      await debug.stop();
      debug.session = null;
      handlerIds.forEach(id => {
        this.handlers[id].dispose();
      });
      this.handlers = {};
    });
  }

  private handlers: { [id: string]: H } = {};
  private builder: new (option: any) => H;
}

/**
 * A plugin that provides visual debugging support for consoles.
 */
const consoles: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/debugger:consoles',
  autoStart: true,
  requires: [IDebugger, ILabShell],
  activate: (app: JupyterFrontEnd, debug: IDebugger, labShell: ILabShell) => {
    const handler = new DebuggerHandler<ConsoleHandler>(ConsoleHandler);

    labShell.currentChanged.connect(async (_, update) => {
      const widget = update.newValue;
      if (!(widget instanceof ConsolePanel)) {
        return;
      }
      await setDebugSession(app, debug, widget.session);
      handler.update(debug, widget);
    });
  }
};

/**
 * A plugin that provides visual debugging support for file editors.
 */
const files: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/debugger:files',
  autoStart: true,
  requires: [IDebugger, IEditorTracker, ILabShell],
  activate: (
    app: JupyterFrontEnd,
    debug: IDebugger,
    tracker: IEditorTracker,
    labShell: ILabShell
  ) => {
    const handler = new DebuggerHandler<FileHandler>(FileHandler);
    const activeSessions: {
      [id: string]: Session.ISession;
    } = {};

    labShell.currentChanged.connect(async (_, update) => {
      const widget = update.newValue;
      if (!(widget instanceof DocumentWidget)) {
        return;
      }

      const content = widget.content;
      if (!(content instanceof FileEditor)) {
        return;
      }

      const sessions = app.serviceManager.sessions;
      try {
        const model = await sessions.findByPath(widget.context.path);
        let session = activeSessions[model.id];
        if (!session) {
          // Use `connectTo` only if the session does not exist.
          // `connectTo` sends a kernel_info_request on the shell
          // channel, which blocks the debug session restore when waiting
          // for the kernel to be ready
          session = sessions.connectTo(model);
          activeSessions[model.id] = session;
        }
        await setDebugSession(app, debug, session);
        handler.update(debug, content);
      } catch {
        return;
      }
    });
  }
};

/**
 * A plugin that provides visual debugging support for notebooks.
 */
const notebooks: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/debugger:notebooks',
  autoStart: true,
  requires: [IDebugger, ILabShell],
  activate: (app: JupyterFrontEnd, debug: IDebugger, labShell: ILabShell) => {
    const handler = new DebuggerHandler<NotebookHandler>(NotebookHandler);

    labShell.currentChanged.connect(async (_, update) => {
      const widget = update.newValue;
      if (!(widget instanceof NotebookPanel)) {
        return;
      }
      await setDebugSession(app, debug, widget.session);
      handler.update(debug, widget);
    });
  }
};

/**
 * A plugin that tracks notebook, console and file editors used for debugging.
 */
const tracker: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/debugger:tracker',
  autoStart: true,
  requires: [IDebugger, IEditorServices],
  optional: [INotebookTracker, IConsoleTracker, IEditorTracker],
  activate: (
    app: JupyterFrontEnd,
    debug: IDebugger,
    editorServices: IEditorServices,
    notebookTracker: INotebookTracker,
    consoleTracker: IConsoleTracker,
    editorTracker: IEditorTracker
  ) => {
    new TrackerHandler({
      shell: app.shell,
      editorServices,
      debuggerService: debug,
      notebookTracker,
      consoleTracker,
      editorTracker
    });
  }
};

/**
 * A plugin providing a tracker code debuggers.
 */
const main: JupyterFrontEndPlugin<IDebugger> = {
  id: '@jupyterlab/debugger:main',
  optional: [ILayoutRestorer, ICommandPalette],
  requires: [IStateDB, IEditorServices, ILabShell],
  provides: IDebugger,
  autoStart: true,
  activate: (
    app: JupyterFrontEnd,
    state: IStateDB,
    editorServices: IEditorServices,
    labShell: ILabShell,
    restorer: ILayoutRestorer | null,
    palette: ICommandPalette | null
  ): IDebugger => {
    const { commands, shell } = app;

    const service = new DebugService();

    let sidebar: Debugger.Sidebar;

    commands.addCommand(CommandIDs.closeDebugger, {
      label: 'Close Debugger',
      execute: () => {
        if (!sidebar) {
          return;
        }
        sidebar.close();
        sidebar.dispose();
      }
    });

    app.contextMenu.addItem({
      command: CommandIDs.closeDebugger,
      selector: '.jp-DebuggerSidebar'
    });

    commands.addCommand(CommandIDs.mount, {
      execute: async () => {
        if (!sidebar) {
          return;
        }

        shell.add(sidebar, 'right');
        if (labShell.currentWidget) {
          labShell.currentWidget.activate();
        }

        if (restorer) {
          restorer.add(sidebar, 'debugger-sidebar');
        }

        await service.restoreState(true);
      }
    });

    commands.addCommand(CommandIDs.debugContinue, {
      label: 'Continue',
      caption: 'Continue',
      iconClass: 'jp-MaterialIcon jp-RunIcon',
      isEnabled: () => {
        return service.hasStoppedThreads();
      },
      execute: async () => {
        await service.continue();
        commands.notifyCommandChanged();
      }
    });

    commands.addCommand(CommandIDs.terminate, {
      label: 'Terminate',
      caption: 'Terminate',
      iconClass: 'jp-MaterialIcon jp-StopIcon',
      isEnabled: () => {
        return service.hasStoppedThreads();
      },
      execute: async () => {
        await service.restart();
        commands.notifyCommandChanged();
      }
    });

    commands.addCommand(CommandIDs.next, {
      label: 'Next',
      caption: 'Next',
      iconClass: 'jp-MaterialIcon jp-StepOverIcon',
      isEnabled: () => {
        return service.hasStoppedThreads();
      },
      execute: async () => {
        await service.next();
      }
    });

    commands.addCommand(CommandIDs.stepIn, {
      label: 'StepIn',
      caption: 'Step In',
      iconClass: 'jp-MaterialIcon jp-StepInIcon',
      isEnabled: () => {
        return service.hasStoppedThreads();
      },
      execute: async () => {
        await service.stepIn();
      }
    });

    commands.addCommand(CommandIDs.stepOut, {
      label: 'StepOut',
      caption: 'Step Out',
      iconClass: 'jp-MaterialIcon jp-StepOutIcon',
      isEnabled: () => {
        return service.hasStoppedThreads();
      },
      execute: async () => {
        await service.stepOut();
      }
    });

    commands.addCommand(CommandIDs.create, {
      label: 'Debugger',
      execute: async () => {
        const callstackCommands = {
          registry: commands,
          continue: CommandIDs.debugContinue,
          terminate: CommandIDs.terminate,
          next: CommandIDs.next,
          stepIn: CommandIDs.stepIn,
          stepOut: CommandIDs.stepOut
        };

        sidebar = new Debugger.Sidebar({
          service,
          callstackCommands,
          editorServices
        });

        sidebar.service.eventMessage.connect(_ => {
          commands.notifyCommandChanged();
        });

        sidebar.service.sessionChanged.connect(_ => {
          commands.notifyCommandChanged();
        });
        await commands.execute(CommandIDs.mount);
      }
    });

    if (palette) {
      const category = 'Debugger';
      [
        CommandIDs.create,
        CommandIDs.debugContinue,
        CommandIDs.terminate,
        CommandIDs.next,
        CommandIDs.stepIn,
        CommandIDs.stepOut
      ].forEach(command => {
        palette.addItem({ command, category });
      });
    }

    void commands.execute(CommandIDs.create);

    return service;
  }
};

/**
 * Export the plugins as default.
 */

const plugins: JupyterFrontEndPlugin<any>[] = [
  consoles,
  files,
  notebooks,
  tracker,
  main
];

export default plugins;
