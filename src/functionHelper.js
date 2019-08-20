'use strict';

const { fork, spawn } = require('child_process');
const path = require('path');
const debugLog = require('./debugLog');
const { createUniqueId } = require('./utils');

const handlerCache = {};
const messageCallbacks = {};

function runProxyHandler(funOptions, options) {
  return (event, context) => {
    const args = ['invoke', 'local', '-f', funOptions.funName];
    const stage = options.s || options.stage;

    if (stage) args.push('-s', stage);

    // Use path to binary if provided, otherwise assume globally-installed
    const binPath = options.b || options.binPath;
    const cmd = binPath || 'sls';

    const process = spawn(cmd, args, {
      cwd: funOptions.servicePath,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    process.stdin.write(`${JSON.stringify(event)}\n`);
    process.stdin.end();
    let results = '';
    process.stdout.on('data', (data) => {
      const str = data.toString('utf-8');
      results += str;
      if (str.length > 0) {
        console.log('Proxy Handler Log:', str);
      }
    });

    process.stderr.on('data', (data) => {
      context.fail(data);
    });

    process.on('close', (code) => {
      if (code.toString() === '0') {
        try {
          // Strip all newlines out of the result string. This is required because of the way the buffer stream
          // adds newlines at each additional chunk, which corrupts the JSON structure if it is sufficiently
          // large.
          const resultsWithoutNewLines = results.replace(/\r?\n|\r/g, '');
          // Search for the last instance of something matching the JSON result structure. We look for the last
          // instance so that we don't accidentally pick up something that looks like the response that has
          // been manually printed in the handler code.
          // https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-output-format
          const proxyResponseRegex = /{[\r\n]?\s*(['"])isBase64Encoded(['"])|{[\r\n]?\s*(['"])statusCode(['"])|{[\r\n]?\s*(['"])headers(['"])|{[\r\n]?\s*(['"])body(['"])|{[\r\n]?\s*(['"])principalId(['"])/g;
          let jsonResponse = null;
          let match = null;
          // eslint-disable-next-line no-cond-assign
          while ((match = proxyResponseRegex.exec(resultsWithoutNewLines))) {
            if (match && match.index > -1) {
              jsonResponse = resultsWithoutNewLines.slice(match.index);
            }
          }
          context.succeed(JSON.parse(jsonResponse));
        } catch (ex) {
          context.fail(results);
        }
      } else {
        context.succeed(code, results);
      }
    });
  };
}

exports.getFunctionOptions = function getFunctionOptions(
  fun,
  funName,
  servicePath,
  serviceRuntime,
) {
  // Split handler into method name and path i.e. handler.run
  // Support nested paths i.e. ./src/somefolder/.handlers/handler.run
  const lastIndexOfDelimiter = fun.handler.lastIndexOf('.');
  const handlerPath = fun.handler.substr(0, lastIndexOfDelimiter);
  const handlerName = fun.handler.substr(lastIndexOfDelimiter + 1);

  return {
    funName,
    funTimeout: (fun.timeout || 30) * 1000,
    handlerName, // i.e. run
    handlerPath: path.join(servicePath, handlerPath),
    memorySize: fun.memorySize,
    runtime: fun.runtime || serviceRuntime,
  };
};

exports.createExternalHandler = function createExternalHandler(
  funOptions,
  options,
) {
  let handlerContext = handlerCache[funOptions.handlerPath];

  function handleFatal(error) {
    debugLog(`External handler received fatal error ${JSON.stringify(error)}`);
    handlerContext.inflight.forEach((id) => messageCallbacks[id](error));
    handlerContext.inflight.clear();
    delete handlerCache[funOptions.handlerPath];
  }

  if (!handlerContext) {
    debugLog(`Loading external handler... (${funOptions.handlerPath})`);

    const helperPath = path.resolve(__dirname, 'ipcHelper.js');
    const env = {};
    for (const key of Object.getOwnPropertyNames(process.env)) {
      if (process.env[key] !== undefined && process.env[key] !== 'undefined')
        env[key] = process.env[key];
    }

    const ipcProcess = fork(helperPath, [funOptions.handlerPath], {
      env,
      stdio: [0, 1, 2, 'ipc'],
    });

    handlerContext = { process: ipcProcess, inflight: new Set() };

    if (options.skipCacheInvalidation) {
      handlerCache[funOptions.handlerPath] = handlerContext;
    }

    ipcProcess.on('message', (message) => {
      debugLog(`External handler received message ${JSON.stringify(message)}`);
      if (message.id && messageCallbacks[message.id]) {
        messageCallbacks[message.id](message.error, message.ret);
        handlerContext.inflight.delete(message.id);
        delete messageCallbacks[message.id];
      } else if (message.error) {
        // Handler died!
        handleFatal(message.error);
      }

      if (!options.skipCacheInvalidation) {
        handlerContext.process.kill();
        delete handlerCache[funOptions.handlerPath];
      }
    });

    ipcProcess.on('error', (error) => handleFatal(error));
    ipcProcess.on('exit', (code) =>
      handleFatal(`Handler process exited with code ${code}`),
    );
  } else {
    debugLog(`Using existing external handler for ${funOptions.handlerPath}`);
  }

  return (event, context, done) => {
    const id = createUniqueId();
    messageCallbacks[id] = done;
    handlerContext.inflight.add(id);
    handlerContext.process.send(
      Object.assign({}, funOptions, { id, event, context }),
    );
  };
};

// Create a function handler
// The function handler is used to simulate Lambda functions
exports.createHandler = function createHandler(funOptions, options) {
  if (options.useSeparateProcesses) {
    return this.createExternalHandler(funOptions, options);
  }

  if (!options.skipCacheInvalidation) {
    debugLog('Invalidating cache...');

    for (const key in require.cache) {
      // Require cache invalidation, brutal and fragile.
      // Might cause errors, if so please submit an issue.
      if (!key.match(options.cacheInvalidationRegex || /node_modules/))
        delete require.cache[key];
    }
    const currentFilePath = __filename;
    if (
      require.cache[currentFilePath] &&
      require.cache[currentFilePath].children
    ) {
      const nextChildren = [];

      require.cache[currentFilePath].children.forEach((moduleCache) => {
        if (
          moduleCache.filename.match(
            options.cacheInvalidationRegex || /node_modules/,
          )
        ) {
          nextChildren.push(moduleCache);
        }
      });

      require.cache[currentFilePath].children = nextChildren;
    }
  }

  debugLog(`Loading handler... (${funOptions.handlerPath})`);

  let handler = null;

  if (funOptions.runtime.startsWith('nodejs')) {
    handler = require(funOptions.handlerPath)[funOptions.handlerName];
  } else {
    handler = runProxyHandler(funOptions, options);
  }

  if (typeof handler !== 'function') {
    throw new Error(
      `Serverless-offline: handler for '${funOptions.funName}' is not a function`,
    );
  }

  return handler;
};

exports.cleanup = function cleanup() {
  for (const key in handlerCache) {
    handlerCache[key].process.kill();
  }
};
