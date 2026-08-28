type TerminalHyperlinkEnvironment = NodeJS.ProcessEnv;

function sanitizeDestination(destination: string) {
  return Array.from(destination, character => (/\p{C}/u.test(character) ? '' : character)).join('');
}

export function webDestination(destination: string) {
  const safeDestination = sanitizeDestination(destination.trim());
  try {
    const parsed = new URL(safeDestination);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname)
      return null;
    return safeDestination;
  } catch {
    return null;
  }
}

export function osc8Hyperlink(destination: string, text: string) {
  const safeDestination = webDestination(destination);
  if (!safeDestination) return text;
  return `\u001b]8;;${safeDestination}\u0007${text}\u001b]8;;\u0007`;
}

export function hideWebLinkDestination(
  destination: string,
  env: TerminalHyperlinkEnvironment = process.env,
  isTerminal = Boolean(process.stdout.isTTY),
) {
  if (!isTerminal || env.STY || env.TMUX || !webDestination(destination)) return false;

  const term = env.TERM?.toLowerCase();
  if (term === 'dumb' || term?.startsWith('screen') || term?.startsWith('tmux')) return false;

  const program = env.TERM_PROGRAM?.toLowerCase();
  if (
    program === 'ghostty' ||
    program === 'iterm.app' ||
    program === 'wezterm' ||
    program === 'vscode' ||
    program === 'alacritty' ||
    program === 'konsole' ||
    program === 'gnome-terminal'
  ) {
    return true;
  }

  return Boolean(
    env.KITTY_WINDOW_ID ||
      env.WEZTERM_EXECUTABLE ||
      env.ALACRITTY_WINDOW_ID ||
      env.WT_SESSION ||
      env.KONSOLE_VERSION ||
      env.VTE_VERSION,
  );
}
