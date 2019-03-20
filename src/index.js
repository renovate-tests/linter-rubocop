'use babel'

// eslint-disable-next-line import/extensions, import/no-extraneous-dependencies
import { CompositeDisposable } from 'atom'
import getRuleMarkDown from './rule-helpers'

const DEFAULT_ARGS = [
  '--cache', 'false',
  '--force-exclusion',
  '--format', 'json',
  '--display-style-guide',
]

const execPathVersions = new Map()

let helpers
let path
let pluralize
let semver

const loadDeps = () => {
  if (!helpers) {
    helpers = require('atom-linter')
  }
  if (!path) {
    path = require('path')
  }
  if (!pluralize) {
    pluralize = require('pluralize')
  }
  if (!semver) {
    semver = require('semver')
  }
}

const parseFromStd = (stdout, stderr) => {
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    // continue regardless of error
  }
  if (typeof parsed !== 'object') { throw new Error(stderr || stdout) }
  return parsed
}

const getProjectDirectory = filePath => (
  atom.project.relativizePath(filePath)[0] || path.dirname(filePath))

const forwardRubocopToLinter = ({
  message: rawMessage, location, severity, cop_name: copName,
}, file, editor) => {
  const [excerpt, url] = rawMessage.split(/ \((.*)\)/, 2)
  let position
  if (location) {
    const { line, column, length } = location
    position = [[line - 1, column - 1], [line - 1, (column + length) - 1]]
  } else {
    position = helpers.generateRange(editor, 0)
  }

  const severityMapping = {
    refactor: 'info',
    convention: 'info',
    warning: 'warning',
    error: 'error',
    fatal: 'error',
  }

  const linterMessage = {
    url,
    excerpt: `${copName}: ${excerpt}`,
    severity: severityMapping[severity],
    description: url ? () => getRuleMarkDown(url) : null,
    location: {
      file,
      position,
    },
  }
  return linterMessage
}

const determineExecVersion = async (command, cwd) => {
  const args = command.slice(1)
  args.push('--version')
  const versionString = await helpers.exec(command[0], args, { cwd, ignoreExitCode: true })
  const versionPattern = /^(\d+\.\d+\.\d+)/i
  const match = versionString.match(versionPattern)
  if (match !== null && match[1]) {
    return match[1]
  }
  throw new Error(`Unable to parse rubocop version from command output: ${versionString}`)
}

const getRubocopVersion = async (command, cwd) => {
  const key = [cwd, command].toString()
  if (!execPathVersions.has(key)) {
    execPathVersions.set(key, await determineExecVersion(command, cwd))
  }
  return execPathVersions.get(key)
}

const getCopNameArg = async (command, cwd) => {
  const version = await getRubocopVersion(command, cwd)
  if (semver.gte(version, '0.52.0')) {
    return ['--no-display-cop-names']
  }

  return []
}

export default {
  activate() {
    this.idleCallbacks = new Set()
    let depsCallbackID
    const installLinterRubocopDeps = () => {
      this.idleCallbacks.delete(depsCallbackID)
      if (!atom.inSpecMode()) {
        require('atom-package-deps').install('linter-rubocop', true)
      }
      loadDeps()
    }
    depsCallbackID = window.requestIdleCallback(installLinterRubocopDeps)
    this.idleCallbacks.add(depsCallbackID)

    this.subscriptions = new CompositeDisposable()

    // Register fix command
    this.subscriptions.add(
      atom.commands.add('atom-text-editor', {
        'linter-rubocop:fix-file': async () => {
          const textEditor = atom.workspace.getActiveTextEditor()

          if (!atom.workspace.isTextEditor(textEditor) || textEditor.isModified()) {
            // Abort for invalid or unsaved text editors
            return atom.notifications.addError('Linter-Rubocop: Please save before fixing')
          }

          const filePath = textEditor.getPath()
          if (!filePath) { return null }

          const cwd = getProjectDirectory(filePath)
          const command = this.command
            .split(/\s+/)
            .filter(i => i)
            .concat(DEFAULT_ARGS, '--auto-correct')
          command.push(...(await getCopNameArg(command, cwd)))
          command.push(filePath)

          const { stdout, stderr } = await helpers.exec(command[0], command.slice(1), { cwd, stream: 'both' })
          const { summary: { offense_count: offenseCount } } = parseFromStd(stdout, stderr)
          return offenseCount === 0
            ? atom.notifications.addInfo('Linter-Rubocop: No fixes were made')
            : atom.notifications.addSuccess(`Linter-Rubocop: Fixed ${pluralize('offenses', offenseCount, true)}`)
        },
      }),
      atom.config.observe('linter-rubocop.command', (value) => {
        this.command = value
      }),
      atom.config.observe('linter-rubocop.disableWhenNoConfigFile', (value) => {
        this.disableWhenNoConfigFile = value
      }),
      atom.config.observe('linter-rubocop.runExtraRailsCops', (value) => {
        this.runExtraRailsCops = value
      }),
    )
  },

  deactivate() {
    this.idleCallbacks.forEach(callbackID => window.cancelIdleCallback(callbackID))
    this.idleCallbacks.clear()
    this.subscriptions.dispose()
  },

  provideLinter() {
    return {
      name: 'RuboCop',
      grammarScopes: [
        'source.ruby',
        'source.ruby.gemfile',
        'source.ruby.rails',
        'source.ruby.rspec',
        'source.ruby.chef',
      ],
      scope: 'file',
      lintsOnChange: true,
      lint: async (editor) => {
        const filePath = editor.getPath()
        if (!filePath) { return null }

        loadDeps()

        if (this.disableWhenNoConfigFile === true) {
          const config = await helpers.findAsync(filePath, '.rubocop.yml')
          if (config === null) {
            return []
          }
        }

        const cwd = getProjectDirectory(filePath)
        const command = this.command
          .split(/\s+/)
          .filter(i => i)
          .concat(DEFAULT_ARGS)
        command.push(...(await getCopNameArg(command, cwd)))
        if (this.runExtraRailsCops) {
          command.push('--rails')
        }
        command.push('--stdin', filePath)
        const stdin = editor.getText()
        const exexOptions = {
          cwd,
          stdin,
          stream: 'both',
          timeout: 10000,
          uniqueKey: `linter-rubocop::${filePath}`,
        }

        let output
        try {
          output = await helpers.exec(command[0], command.slice(1), exexOptions)
        } catch (e) {
          if (e.message !== 'Process execution timed out') throw e
          atom.notifications.addInfo(
            'Linter-Rubocop: Linter timed out',
            {
              description: 'Make sure you are not running Rubocop with a slow-starting interpreter like JRuby. '
                           + 'If you are still seeing timeouts, consider running your linter `on save` and not `on change`, '
                           + 'or reference https://github.com/AtomLinter/linter-rubocop/issues/202 .',
            },
          )
          return null
        }
        // Process was canceled by newer process
        if (output === null) { return null }

        const { files } = parseFromStd(output.stdout, output.stderr)
        const offenses = files && files[0] && files[0].offenses
        return (offenses || []).map(offense => forwardRubocopToLinter(offense, filePath, editor))
      },
    }
  },
}
