// Clearing one pane's progress mark, by the only road that reaches the tab.
//
// The hook sets every mark: Claude Code prints the hook's `terminalSequence` on its own
// stdout, so the OSC 9;4 bytes travel down the pane's pty and VS Code's terminal parses them.
// A clear has to arrive the same way, on the OUTPUT side of that pty. The two APIs that look
// as if they would do it both write to the shell's stdin instead -- `Terminal.sendText`, and
// `workbench.action.terminal.sendSequence`, which is literally `instance.sendText(resolved,
// false)` -- so their bytes would land in Claude's input box, not on the tab. A
// `Pseudoterminal` cannot attach to a terminal the extension did not create. So on darwin and
// linux the clear is written straight to the pane's pty device, `/dev/ttysNNN` or
// `/dev/pts/N`, exactly as a program running in that pane would write it.
//
// Four rules this file is built around, each load-bearing:
//
//   * ONE WRITE, NEVER A LOOP. Claude is writing to the same device. A second write to finish
//     a short first one could land in the middle of Claude's own output and split an escape
//     sequence in two, which garbles the terminal. A short write is logged and reported, never
//     topped up.
//   * NEVER BLOCK. The extension host runs every extension in the window on one thread, so a
//     write that waits on a full pty buffer freezes all of them. The device opens
//     O_NONBLOCK: a full buffer answers EAGAIN, and the clear is dropped rather than waited on.
//     A platform whose fs cannot say O_NONBLOCK does not get the device opened at all.
//   * O_NOCTTY. Opening a tty without it can make that tty the opener's controlling terminal
//     (System V semantics, which linux keeps), and then a hangup on one pane would signal the
//     whole extension host. On darwin the flag changes nothing and costs nothing.
//   * NEVER THROW, NEVER GUESS A DEVICE, NEVER WRITE A FILE. A failed clear leaves a spurious
//     mark the member can dismiss by clicking again; a thrown one escapes into the event loop.
//     Every failure is logged with its path and error code and answered as `ok: false`. With
//     no tty known, nothing is opened. And once a path is open, fstat must call it a character
//     device before a byte goes out, so a wrong path that names a regular file is refused
//     rather than having its first bytes overwritten.
//
// win32 gets no clear from here at all, by design. `AttachConsole` cannot run inside the
// extension host -- one console per process, and `FreeConsole` would detach the host -- and
// ConPTY reorders OSC sequences, so a clear could overtake the mark it cancels. A deferred
// road was built and then taken out: a flag the hook would turn into a clear could only ever
// be consumed at the end of the pane's next turn, since `Stop` and `StopFailure` are the only
// registered events that resolve to unread, and there it replaced that turn's completion mark
// with a clear -- eating the very mark the feature exists to show. So win32 opens nothing,
// writes nothing and logs nothing, because a documented platform gap is not an error; the
// member's next message supersedes the mark with the spinner.
import { Buffer } from 'node:buffer';
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { SEQUENCES } from './decision.ts';

/** The platforms whose panes have a pty device to write to. Linux rides the Mac road. */
const TTY_PLATFORMS: readonly NodeJS.Platform[] = Object.freeze(['darwin', 'linux']);

/** Every line this module logs opens with this, so it reads plainly in any output channel. */
const LOG_PREFIX = 'pane-pulse writer: ';

/** The two errno codes a non-blocking write answers when the pty buffer is full. */
const BUFFER_FULL_CODES: readonly string[] = Object.freeze(['EAGAIN', 'EWOULDBLOCK']);

/** What win32 answers, every time. A platform gap the README documents, so it is not logged. */
const WIN32_GAP =
  'win32 has no road to a tab mark from the extension host, so nothing was written: the mark ' +
  'clears on the next message.';

/** The pane to clear, as the mapper resolved it. */
export type ClearTarget = {
  /** The shell pid `Terminal.processId` reports. Named in every log line, never written to. */
  readonly shell_pid: number;
  /** The pane's pty device, absolute (`/dev/ttys003`, `/dev/pts/3`); null when none is known. */
  readonly ttyPath: string | null;
  /** The Claude process in that pane. Carried so a caller can name the pane; no road needs it. */
  readonly claude_pid: number;
};

/**
 * What a clear did. `how` names the road taken: `tty` when a device was opened or tried,
 * `none` when no road was open at all (no tty known, win32, or a platform with neither). `ok`
 * is true only when the whole sequence was written to a character device and every handle was
 * released cleanly.
 */
export type ClearResult = {
  readonly ok: boolean;
  readonly how: 'tty' | 'none';
  readonly detail?: string;
};

/**
 * The slice of node:fs this module touches, so a test can hand in a fake device. node:fs
 * satisfies it as it stands. On win32, node leaves O_NOCTTY and O_NONBLOCK undefined whatever
 * this type says, which is why the tty road checks them at run time before it opens anything.
 */
export type WriterFs = {
  readonly constants: {
    readonly O_WRONLY: number;
    readonly O_NOCTTY: number;
    readonly O_NONBLOCK: number;
  };
  readonly openSync: (path: string, flags: number) => number;
  readonly fstatSync: (fd: number) => { readonly isCharacterDevice: () => boolean };
  readonly writeSync: (fd: number, buffer: Uint8Array) => number;
  readonly closeSync: (fd: number) => void;
};

/** Everything `clearIndicator` reaches for, each defaulted so production passes nothing. */
export type ClearDeps = {
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to node:fs. */
  readonly fs?: WriterFs;
  /** Where failures are reported: the extension passes its output channel. */
  readonly log?: (line: string) => void;
};

type Log = (line: string) => void;

const NODE_FS: WriterFs = Object.freeze({
  constants,
  openSync,
  fstatSync,
  writeSync,
  closeSync,
});

/** Only reached when the caller wired no log: the extension host's own log, not silence. */
function defaultLog(line: string): void {
  console.error(line);
}

/** A log that throws -- a disposed output channel, say -- must not turn a clear into a throw. */
function quiet(log: Log): Log {
  return (line: string): void => {
    try {
      log(line);
    } catch {
      // Nowhere left to report it, and a clear must never throw.
    }
  };
}

function codeOf(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { readonly code?: unknown }).code;
      if (typeof code === 'string' && code !== '') return code;
    }
  } catch {
    // A hostile error object still gets reported, as having no code.
  }
  return 'no error code';
}

function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'an error that could not be printed';
  }
}

function success(how: ClearResult['how'], detail: string): ClearResult {
  return Object.freeze({ ok: true, how, detail });
}

function failure(log: Log, how: ClearResult['how'], detail: string): ClearResult {
  log(`${LOG_PREFIX}${detail}`);
  return Object.freeze({ ok: false, how, detail });
}

/** A caught error, reported with what was being done, to which path, and the errno code. */
function failureFrom(
  log: Log,
  how: ClearResult['how'],
  what: string,
  error: unknown,
  note = '',
): ClearResult {
  return failure(log, how, `${what} (${codeOf(error)}): ${messageOf(error)}${note}`);
}

/**
 * The flags the device opens with, or null when this fs cannot name all three. Deliberately
 * no O_CREAT, O_TRUNC or O_APPEND: a wrong path fails to open rather than becoming a new file.
 */
function ttyOpenFlags(fsConstants: WriterFs['constants']): number | null {
  const { O_WRONLY, O_NOCTTY, O_NONBLOCK } = fsConstants;
  for (const flag of [O_WRONLY, O_NOCTTY, O_NONBLOCK]) {
    if (typeof flag !== 'number' || !Number.isInteger(flag)) return null;
  }
  return O_WRONLY | O_NOCTTY | O_NONBLOCK;
}

function clearByTty(target: ClearTarget, fs: WriterFs, log: Log): ClearResult {
  const { shell_pid: shellPid, ttyPath } = target;
  if (ttyPath === null || ttyPath === '') {
    return failure(
      log,
      'none',
      `no tty is known for shell pid ${shellPid}, so nothing was written: a device is never guessed`,
    );
  }
  if (!isAbsolute(ttyPath)) {
    return failure(
      log,
      'none',
      `tty path ${JSON.stringify(ttyPath)} for shell pid ${shellPid} is not absolute, so nothing ` +
        'was written: a device is never guessed',
    );
  }
  const flags = ttyOpenFlags(fs.constants);
  if (flags === null) {
    return failure(
      log,
      'none',
      `${ttyPath} was not opened: this fs cannot name O_WRONLY, O_NOCTTY and O_NONBLOCK, and a ` +
        'tty opened without O_NONBLOCK could block the whole extension host',
    );
  }

  const bytes = Buffer.from(SEQUENCES.clear, 'utf8');

  let fd: number;
  try {
    fd = fs.openSync(ttyPath, flags);
  } catch (error) {
    return failureFrom(log, 'tty', `could not open ${ttyPath} for shell pid ${shellPid}`, error);
  }

  let outcome: ClearResult;
  // What is being attempted, so a throw from either step is reported as that step.
  let step = `could not check that ${ttyPath} for shell pid ${shellPid} is a terminal device`;
  try {
    if (!fs.fstatSync(fd).isCharacterDevice()) {
      outcome = failure(
        log,
        'tty',
        `${ttyPath} for shell pid ${shellPid} is not a character device, so nothing was ` +
          'written: a wrong path must never overwrite the start of a file',
      );
    } else {
      step = `could not write the clear to ${ttyPath} for shell pid ${shellPid}`;
      // Exactly one call, whatever it answers. See the header: a second write could split an
      // escape sequence across Claude's own output.
      const written = fs.writeSync(fd, bytes);
      outcome =
        written === bytes.length
          ? success('tty', `wrote the ${bytes.length}-byte clear to ${ttyPath}`)
          : failure(
              log,
              'tty',
              `wrote ${String(written)} of ${bytes.length} bytes of the clear to ${ttyPath} for ` +
                `shell pid ${shellPid}; not retried, because a second write could land inside ` +
                "Claude's own output",
            );
    }
  } catch (error) {
    const note = BUFFER_FULL_CODES.includes(codeOf(error))
      ? " -- the pane's pty buffer is full, so the clear is dropped rather than waited on"
      : '';
    outcome = failureFrom(log, 'tty', step, error, note);
  } finally {
    try {
      fs.closeSync(fd);
    } catch (error) {
      outcome = failureFrom(
        log,
        'tty',
        `could not close ${ttyPath} (fd ${fd}) for shell pid ${shellPid}`,
        error,
      );
    }
  }
  return outcome;
}

/**
 * Clear one pane's progress mark. darwin and linux write `SEQUENCES.clear` to the pane's pty
 * device in one non-blocking write, once fstat has confirmed it is a character device. win32
 * opens nothing, writes nothing and logs nothing: it answers `how: 'none'`, because no road
 * from the extension host reaches a Windows tab mark. Synchronous, because it is one tiny
 * write. Never throws: every failure is logged through `deps.log` with its path and error
 * code, and answered as `ok: false`.
 */
export function clearIndicator(target: ClearTarget, deps: ClearDeps = {}): ClearResult {
  const log = quiet(deps.log ?? defaultLog);
  try {
    const platform = deps.platform ?? process.platform;
    // Decided before the fs is so much as looked at: win32 touches nothing.
    if (platform === 'win32') return Object.freeze({ ok: false, how: 'none', detail: WIN32_GAP });
    if (TTY_PLATFORMS.includes(platform)) return clearByTty(target, deps.fs ?? NODE_FS, log);
    return failure(
      log,
      'none',
      `${platform} has no road to clear a pane's mark (the tty road is ` +
        `${TTY_PLATFORMS.join(' and ')}), so nothing was written`,
    );
  } catch (error) {
    // The last net, for a failure nobody foresaw (an fs whose properties throw, say): the
    // contract is that a clear never throws, so even this is answered, never raised.
    return failureFrom(log, 'none', 'unexpected failure while clearing a pane', error);
  }
}
