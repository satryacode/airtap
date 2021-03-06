#!/usr/bin/env node
var path = require('path')
var fs = require('fs')

var colors = require('colors')
var program = require('commander')
var yaml = require('yamljs')
var os = require('os')
var findNearestFile = require('find-nearest-file')
var _ = require('lodash')

var Zuul = require('../lib/zuul')
var scoutBrowser = require('../lib/scout_browser')
var flattenBrowser = require('../lib/flatten_browser')

program
  .version(require('../package.json').version)
  .usage('[options] <files | dir>')
  .option('--ui <testing ui>', 'ui for tests (mocha-bdd, mocha-tdd, qunit, tape)')
  .option('--local [port]', 'port for manual testing in a local browser')
  .option('--phantom [port]', 'run tests in phantomjs. PhantomJS must be installed separately.')
  .option('--phantom-remote-debugger-port [port]', 'connect phantom to remote debugger')
  .option('--phantom-remote-debugger-autorun', 'run tests automatically when --phantom-remote-debugger-port is specified')
  .option('--electron', 'run tests in electron. electron must be installed separately.')
  .option('--sauce-connect [tunnel-identifier]', 'establish a tunnel with sauce connect. Optionally specify the tunnel-identifier')
  .option('--loopback <host name>', 'hostname to use instead of localhost, to accomodate Safari and Edge with Sauce Connect. Must resolve to 127.0.0.1')
  .option('--server <the server script>', 'specify a server script to be run')
  .option('--list-available-browsers', 'list available browsers and versions')
  .option('--browser-name <browser name>', 'specficy the browser name to test an individual browser')
  .option('--browser-version <browser version>', 'specficy the browser version to test an individual browser')
  .option('--browser-platform <browser platform>', 'specficy the browser platform to test an individual browser')
  .option('--browser-retries <retries>', 'number of retries allowed when trying to start a cloud browser, default to 6')
  .option('--browser-output-timeout <timeout>', 'how much time to wait between two test results, default to -1 (no timeout)')
  .option('--concurrency <n>', 'specify the number of concurrent browsers to test')
  .option('--no-coverage', 'disable code coverage analysis with istanbul')
  .option('--no-instrument', 'disable code coverage instrumentation with istanbul')
  .option('--open', 'open a browser automatically. only used when --local is specified')
  .parse(process.argv)

var config = {
  files: program.args,
  local: program.local,
  ui: program.ui,
  phantom: program.phantom,
  phantomRemoteDebuggerPort: program.phantomRemoteDebuggerPort,
  phantomRemoteDebuggerAutorun: program.phantomRemoteDebuggerAutorun,
  electron: program.electron,
  prj_dir: process.cwd(),
  sauce_connect: program.sauceConnect,
  loopback: program.loopback,
  server: program.server,
  concurrency: program.concurrency,
  coverage: program.coverage,
  instrument: program.instrument,
  open: program.open,
  browser_retries: program.browserRetries && parseInt(program.browserRetries, 10),
  browser_output_timeout: program.browserOutputTimeout && parseInt(program.browserOutputTimeout, 10),
  browser_open_timeout: program.browserOpenTimeout && parseInt(program.browserOpenTimeout, 10)
}

// Remove unspecified flags
for (var key in config) {
  if (typeof config[key] === 'undefined') {
    delete config[key]
  }
}

if (!process.stdout.isTTY) {
  colors.setTheme({
    bold: 'stripColors',
    italic: 'stripColors',
    underline: 'stripColors',
    inverse: 'stripColors',
    yellow: 'stripColors',
    cyan: 'stripColors',
    white: 'stripColors',
    magenta: 'stripColors',
    green: 'stripColors',
    red: 'stripColors',
    grey: 'stripColors',
    blue: 'stripColors',
    rainbow: 'stripColors',
    zebra: 'stripColors',
    random: 'stripColors'
  })
}

if (program.listAvailableBrowsers) {
  scoutBrowser(function (err, allBrowsers) {
    if (err) {
      console.error('Unable to get available browsers for saucelabs'.red)
      console.error(err.stack)
      return process.exit(1)
    }

    for (var browser in allBrowsers) {
      console.log(browser)
      var versions = _.uniq(_.pluck(allBrowsers[browser], 'version')).sort(function (a, b) {
        var aNum = Number(a)
        var bNum = Number(b)

        if (aNum && !bNum) {
          return -1
        } else if (!aNum && bNum) {
          return 1
        } else if (a === b) {
          return 0
        } else if (aNum > bNum) {
          return 1
        }

        return -1
      })
      var platforms = _.sortBy(_.uniq(_.pluck(allBrowsers[browser], 'platform')))

      console.log('   Versions: ' + versions.join(', '))
      console.log('   Platforms: ' + platforms.join(', '))
    }
  })
} else if (config.files.length === 0) {
  console.error('at least one `js` test file must be specified')
  process.exit(1)
} else if ((program.browserVersion || program.browserPlatform) && !program.browserName) {
  console.error('the browser name needs to be specified (via --browser-name)')
  process.exit(1)
} else if ((program.browserName || program.browserPlatform) && !program.browserVersion) {
  console.error('the browser version needs to be specified (via --browser-version)')
  process.exit(1)
}

config = readLocalConfig(config)

// Overwrite browsers from command line arguments
if (program.browserName) {
  Object.assign(config, { browsers: [{ name: program.browserName, version: program.browserVersion, platform: program.browserPlatform }] })
}

config = readGlobalConfig(config)
config.username = process.env.SAUCE_USERNAME || config.sauce_username
config.key = process.env.SAUCE_ACCESS_KEY || config.sauce_key

// Default to tape, as we intend to remove others.
config.ui = config.ui || 'tape'

var pkg = {}
try {
  pkg = require(process.cwd() + '/package.json')
} catch (err) {}

config.name = config.name || pkg.name || 'airtap'

if (config.builder) {
  // relative path will needs to be under project dir
  if (config.builder[0] === '.') {
    config.builder = path.resolve(config.prj_dir, config.builder)
  }

  config.builder = require.resolve(config.builder)
}

var zuul = Zuul(config)

if (config.local) {
  zuul.run(function (err, passed) {
    if (err) throw err
  })
} else if (config.phantom || config.electron) {
  zuul.run(function (err, passed) {
    if (err) throw err
    process.exit(passed ? 0 : 1)
  })
} else if (!config.username || !config.key) {
  console.error('Error:')
  console.error('Airtap tried to run tests in saucelabs, however no saucelabs credentials were provided.')
  console.error('See the zuul wiki (https://github.com/defunctzombie/zuul/wiki/Cloud-testing) for info on how to setup cloud testing.')
  process.exit(1)
} else {
  scoutBrowser(function (err, allBrowsers) {
    var browsers = []

    if (err) {
      console.error('Unable to get available browsers for saucelabs'.red)
      console.error(err.stack)
      return process.exit(1)
    }

    // common mappings for some of us senile folks
    allBrowsers.iexplore = allBrowsers['internet explorer']
    allBrowsers.ie = allBrowsers['internet explorer']
    allBrowsers.googlechrome = allBrowsers.chrome

    if (!config.browsers) {
      console.error('no cloud browsers specified in .airtap.yml')
      return process.exit(1)
    }

    // flatten into list of testable browsers
    var toTest = flattenBrowser(config.browsers, allBrowsers)

    // pretty prints which browsers we will test on what platforms
    var byOs = {}
    toTest.forEach(function (browser) {
      var key = browser.name + ' @ ' + browser.platform;
      (byOs[key] = byOs[key] || []).push(browser.version)
    })

    for (var item in byOs) {
      console.log('- testing: %s: %s'.grey, item, byOs[item].join(' '))
    }

    toTest.forEach(function (info) {
      zuul.browser(info)
    })

    var passedTestsCount = 0
    var failedBrowsersCount = 0
    var lastOutputName

    zuul.on('browser', function (browser) {
      browsers.push(browser)

      var name = browser.toString()
      var waitInterval

      browser.once('init', function () {
        console.log('- queuing: %s'.grey, name)
      })

      browser.on('start', function (reporter) {
        console.log('- starting: %s'.white, name)

        clearInterval(waitInterval)
        waitInterval = setInterval(function () {
          console.log('- waiting: %s'.yellow, name)
        }, 1000 * 30)

        var currentTest
        reporter.on('test', function (test) {
          currentTest = test
        })

        reporter.on('console', function (msg) {
          if (lastOutputName !== name) {
            lastOutputName = name
            console.log('%s console'.white, name)
          }

          // When testing with microsoft edge:
          // Adds length property to array-like object if not defined to execute console.log properly
          if (msg.args.length === undefined) {
            msg.args.length = Object.keys(msg.args).length
          }
          console.log.apply(console, msg.args)
        })

        reporter.on('assertion', function (assertion) {
          console.log()
          console.log('%s %s'.red, name, currentTest ? currentTest.name : 'undefined test')
          console.log('Error: %s'.red, assertion.message)

          // When testing with microsoft edge:
          // Adds length property to array-like object if not defined to execute forEach properly
          if (assertion.frames.length === undefined) {
            assertion.frames.length = Object.keys(assertion.frames).length
          }
          Array.prototype.forEach.call(assertion.frames, function (frame) {
            console.log('    %s %s:%d'.grey, frame.func, frame.filename, frame.line)
          })
          console.log()
        })

        reporter.once('done', function () {
          clearInterval(waitInterval)
        })
      })

      browser.once('done', function (results) {
        passedTestsCount += results.passed

        if (results.failed > 0 || results.passed === 0) {
          console.log('- failed: %s (%d failed, %d passed)'.red, name,
            results.failed, results.passed)
          failedBrowsersCount++
          return
        }
        console.log('- passed: %s'.green, name)
      })
    })

    zuul.on('restart', function (browser) {
      var name = browser.toString()
      console.log('- restarting: %s'.red, name)
    })

    zuul.on('error', function (err) {
      shutdownAllBrowsers(function () {
        throw err.message
      })
    })

    zuul.run(function (err, passed) {
      if (err) throw err

      if (failedBrowsersCount > 0) {
        console.log('%d browser(s) failed'.red, failedBrowsersCount)
      } else if (passedTestsCount === 0) {
        console.log('no tests ran'.yellow)
      } else {
        console.log('all browsers passed'.green)
      }

      process.exit((passedTestsCount > 0 && failedBrowsersCount === 0) ? 0 : 1)
    })

    function shutdownAllBrowsers (done) {
      var Batch = require('batch')
      var batch = new Batch()

      browsers.forEach(function (browser) {
        batch.push(function (done) {
          browser.shutdown()
          browser.once('done', done)
        })
      })

      batch.end(done)
    }
  })
}

function readLocalConfig (config) {
  var yaml = path.join(process.cwd(), '.airtap.yml')
  var js = path.join(process.cwd(), 'airtap.config.js')
  var yamlExists = fs.existsSync(yaml)
  var jsExists = fs.existsSync(js)
  if (yamlExists && jsExists) {
    console.error('both .airtap.yaml and airtap.config.js are found in the project directory, please choose one')
    process.exit(1)
  } else if (yamlExists) {
    return mergeConfig(config, readYAMLConfig(yaml))
  } else if (jsExists) {
    return mergeConfig(config, require(js))
  }
  return config
}

function readGlobalConfig (config) {
  var filename = findNearestFile('.airtaprc') || path.join(os.homedir(), '.airtaprc')
  if (fs.existsSync(filename)) {
    var globalConfig
    try {
      globalConfig = require(filename)
    } catch (_err) {
      globalConfig = readYAMLConfig(filename)
    }
    return mergeConfig(config, globalConfig)
  }
  return config
}

function readYAMLConfig (filename) {
  return yaml.parse(fs.readFileSync(filename, 'utf-8'))
}

function mergeConfig (config, update) {
  config = Object.assign({}, update, config)
  return config
}

// vim: ft=javascript
