'use strict';
// Shell integration: the rc-file snippets that make a remote shell emit
// OSC 133 semantic marks, so prompt navigation, copy-last-command-output
// and failed-command markers light up on Linux boxes the way they already
// do on the fixture devices.
//
// The marks, per command cycle:
//   A  prompt starts        (emitted just before the prompt is drawn)
//   B  prompt ends          (end of PS1: input begins here)
//   C  output begins        (the command was submitted)
//   D;n command finished    (n is the exit status)
//
// Bash uses PS0 where it exists (4.4+, so anything current - Debian 12,
// RHEL 9, Ubuntu 22.04+) because PS0 is printed after a command is read
// and before it runs, which is exactly the C mark with no DEBUG trap and
// none of a DEBUG trap's misfires on completion and PROMPT_COMMAND. Older
// bash falls back to the trap with the guards that need.

const FILE_NAME = '.rsmultiterm-shell-integration.sh';
const MARKER = 'rsmultiterm-shell-integration';

const BASH = `# RSMultiTerm shell integration (OSC 133 semantic prompts).
# Safe to source twice; delete this file and the line in your rc file to
# remove it. Nothing here talks to the network or changes your prompt's
# appearance - it only adds zero-width markers around it.
if [ -n "\${BASH_VERSION-}" ] && [ -z "\${RSMT_SHELL_INTEGRATION-}" ]; then
  RSMT_SHELL_INTEGRATION=1

  # D is emitted on every prompt EXCEPT the first: with PS0 marking C,
  # nothing runs between the command and here that could set a flag, so
  # "have we drawn a prompt before" is the honest test for "did a command
  # just finish". (An empty Enter therefore reports D;0 with no C, which
  # is exactly what it was: a command that did nothing.)
  __rsmt_precmd() {
    local __rsmt_ret=$?
    if [ -n "\${__rsmt_seen-}" ]; then
      printf '\\033]133;D;%s\\007' "$__rsmt_ret"
    fi
    __rsmt_seen=1
    __rsmt_running=""
    printf '\\033]133;A\\007'
  }

  # PS1 gets the "input starts here" mark. \\[ \\] tells bash the bytes are
  # zero-width, without which its line-wrap arithmetic drifts and long
  # command lines start overwriting themselves.
  PS1="\${PS1}\\[\\033]133;B\\007\\]"
  PROMPT_COMMAND="__rsmt_precmd\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"

  if [ "\${BASH_VERSINFO[0]}" -gt 4 ] || { [ "\${BASH_VERSINFO[0]}" -eq 4 ] && [ "\${BASH_VERSINFO[1]}" -ge 4 ]; }; then
    # PS0 is printed after the command is read, before it runs.
    PS0="\\033]133;C\\007\${PS0-}"
  else
    # Pre-4.4: the DEBUG trap, skipping our own prompt machinery and
    # completion, and firing once per submitted command.
    __rsmt_preexec() {
      case "$BASH_COMMAND" in __rsmt_*) return ;; esac
      [ -n "\${COMP_LINE-}" ] && return
      [ -n "\${__rsmt_running-}" ] && return
      __rsmt_running=1
      printf '\\033]133;C\\007'
    }
    trap '__rsmt_preexec' DEBUG
  fi
fi
`;

const ZSH = `# RSMultiTerm shell integration (OSC 133 semantic prompts).
if [ -n "\${ZSH_VERSION-}" ] && [ -z "\${RSMT_SHELL_INTEGRATION-}" ]; then
  RSMT_SHELL_INTEGRATION=1

  __rsmt_precmd() {
    local ret=$?
    if [ -n "\${__rsmt_running-}" ]; then
      print -n "\\033]133;D;\${ret}\\007"
    fi
    __rsmt_running=""
    print -n "\\033]133;A\\007"
  }
  __rsmt_preexec() {
    __rsmt_running=1
    print -n "\\033]133;C\\007"
  }
  # %{ %} is zsh's zero-width bracket, the same job bash's \\[ \\] does.
  PS1="\${PS1}%{\\033]133;B\\007%}"
  precmd_functions+=(__rsmt_precmd)
  preexec_functions+=(__rsmt_preexec)
fi
`;

const FISH = `# RSMultiTerm shell integration (OSC 133 semantic prompts).
if not set -q RSMT_SHELL_INTEGRATION
    set -g RSMT_SHELL_INTEGRATION 1

    function __rsmt_preexec --on-event fish_preexec
        printf '\\033]133;C\\007'
    end
    function __rsmt_postexec --on-event fish_postexec
        printf '\\033]133;D;%s\\007' $status
    end
    # Wrap the existing prompt rather than replacing it.
    if functions -q fish_prompt
        functions -c fish_prompt __rsmt_inner_prompt
        function fish_prompt
            printf '\\033]133;A\\007'
            __rsmt_inner_prompt
            printf '\\033]133;B\\007'
        end
    end
end
`;

const SHELLS = {
    bash: { snippet: BASH, rc: '~/.bashrc', source: `[ -f ~/${FILE_NAME} ] && . ~/${FILE_NAME}` },
    zsh: { snippet: ZSH, rc: '~/.zshrc', source: `[ -f ~/${FILE_NAME} ] && . ~/${FILE_NAME}` },
    fish: {
        snippet: FISH,
        rc: '~/.config/fish/config.fish',
        source: `test -f ~/${FILE_NAME}; and source ~/${FILE_NAME}`,
    },
};

// The commands that install it, as they will be typed into the session.
// The heredoc terminator is QUOTED so the shell expands nothing on the way
// in - the snippet is full of $, backticks and backslashes that must land
// on disk exactly as written.
function installScript(shell) {
    const s = SHELLS[shell];
    if (!s) throw new Error(`unknown shell: ${shell}`);
    const lines = [
        `cat > ~/${FILE_NAME} <<'RSMT_EOF'`,
        s.snippet.trimEnd(),
        'RSMT_EOF',
    ];
    if (shell === 'fish') {
        lines.push('mkdir -p ~/.config/fish');
        lines.push(`grep -qs '${MARKER}' ${s.rc} || echo '${s.source}' >> ${s.rc}`);
        lines.push(`source ~/${FILE_NAME}`);
    } else {
        // grep -qs: quiet, and no complaint when the rc file does not exist
        // yet. The guard makes a second install a no-op rather than a
        // duplicate line.
        lines.push(`grep -qs '${MARKER}' ${s.rc} || printf '\\n%s\\n' '${s.source}' >> ${s.rc}`);
        lines.push(`. ~/${FILE_NAME}`);
    }
    return lines.join('\n');
}

function uninstallScript(shell) {
    const s = SHELLS[shell];
    if (!s) throw new Error(`unknown shell: ${shell}`);
    return [
        `rm -f ~/${FILE_NAME}`,
        `sed -i '/${MARKER}/d' ${s.rc} 2>/dev/null || true`,
    ].join('\n');
}

// Apply to the running shell only: no files touched, gone at logout. The
// honest default for someone else's box.
function sessionScript(shell) {
    const s = SHELLS[shell];
    if (!s) throw new Error(`unknown shell: ${shell}`);
    return s.snippet.trimEnd();
}

function info(shell) {
    const s = SHELLS[shell];
    if (!s) throw new Error(`unknown shell: ${shell}`);
    return { shell, rc: s.rc, file: `~/${FILE_NAME}` };
}

module.exports = {
    shells: () => Object.keys(SHELLS),
    installScript, uninstallScript, sessionScript, info,
    FILE_NAME, MARKER,
};
