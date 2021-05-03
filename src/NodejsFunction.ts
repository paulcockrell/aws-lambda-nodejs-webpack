import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as process from "process";

import * as lambda from "@aws-cdk/aws-lambda";
import * as cdk from "@aws-cdk/core";
import * as spawn from "cross-spawn";
import findUp from "find-up";

/**
 * Properties for a NodejsFunction
 */
export interface NodejsFunctionProps extends lambda.FunctionOptions {
  /**
   * Path to the entry file (JavaScript or TypeScript), relative to your project root
   */
  readonly entry: string;

  /**
   * The name of the exported handler in the entry file.
   *
   * @default "handler"
   */
  readonly handler?: string;

  /**
   * The runtime environment. Only runtimes of the Node.js family are
   * supported.
   *
   * @default - `NODEJS_14_X` if `process.versions.node` >= '14.0.0',
   * `NODEJS_12_X` otherwise.
   */
  readonly runtime?: lambda.Runtime;

  /**
   * If you get "Module not found: Error: Can't resolve 'module_name'" errors, and you're not
   * actually using those modules, then it means there's a module you're using that is trying to
   * dynamically require other modules. This is the case with Knex.js. When this happens, pass all the modules
   * names found in the build error in this array.
   *
   * Example if you're only using PostgreSQL with Knex.js, use:
   *  `modulesToIgnore: ["mssql", "pg-native", "pg-query-stream", "tedious"]`
   */
  readonly modulesToIgnore?: string[];

  /**
   * Externals not to be bundled with your lambda, default to all Node.js builtin modules and aws-sdk. Modules I use this for: @sentry/serverless for example
   */
  readonly externals?: ["aws-sdk"];

  /**
   * Whether to automatically reuse TCP connections when working with the AWS
   * SDK for JavaScript.
   *
   * This sets the `AWS_NODEJS_CONNECTION_REUSE_ENABLED` environment variable
   * to `1`.
   *
   * @see https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/node-reusing-connections.html
   *
   * @default true
   */
  readonly awsSdkConnectionReuse?: boolean;
}

/**
 * A Node.js Lambda function bundled using Parcel
 */
export class NodejsFunction extends lambda.Function {
  constructor(
    scope: cdk.Construct,
    id: string,
    props: NodejsFunctionProps = { entry: "" },
  ) {
    if (props.runtime && props.runtime.family !== lambda.RuntimeFamily.NODEJS) {
      throw new Error("Only `NODEJS` runtimes are supported.");
    }

    if (!/\.(js|ts)$/.test(props.entry)) {
      throw new Error(
        "Only JavaScript or TypeScript entry files are supported.",
      );
    }

    const entryFullPath = path.resolve(props.entry);

    if (!fs.existsSync(entryFullPath)) {
      throw new Error(`Cannot find entry file at ${entryFullPath}`);
    }

    const userExternals = props.externals ?? [];
    const defaultExternals = ["aws-sdk"];

    const handler = props.handler ?? "handler";
    const defaultRunTime =
      nodeMajorVersion() >= 14
        ? lambda.Runtime.NODEJS_14_X
        : lambda.Runtime.NODEJS_12_X;
    const runtime = props.runtime ?? defaultRunTime;

    const outputDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "aws-lambda-nodejs-webpack"),
    );
    const webpackConfigPath = path.join(outputDir, "webpack.config.js");

    const webpackBinPath = require.resolve("webpack-cli/bin/cli.js", {
      paths: [__dirname],
    });

    const pluginsPath = path.join(
      webpackBinPath.slice(0, webpackBinPath.lastIndexOf("/node_modules")),
      "node_modules",
    );

    const pluginsPaths = {
      webpack: findModulePath("webpack", pluginsPath),
      "babel-loader": findModulePath("babel-loader", pluginsPath),
      "@babel/preset-env": findModulePath("@babel/preset-env", pluginsPath),
      "@babel/plugin-transform-runtime": findModulePath(
        "@babel/plugin-transform-runtime",
        pluginsPath,
      ),
      "babel-plugin-source-map-support": findModulePath(
        "babel-plugin-source-map-support",
        pluginsPath,
      ),
      noop2: findModulePath("noop2", pluginsPath),
      "terser-webpack-plugin": findModulePath(
        "terser-webpack-plugin",
        pluginsPath,
      ),
    };

    // NodeJs reserves '\' as an escape char; but pluginsPaths etc are inlined directly in the
    // TemplateString below, so will contain this escape character on paths computed when running
    // the Construct on a Windows machine, and so we need to escape these chars before writing them
    const escapePathForNodeJs = (path: string) => {
      return path.replace(/\\/g, "\\\\");
    };

    const webpackConfiguration = `
    const { builtinModules } = require("module");
    const { NormalModuleReplacementPlugin } = require("${escapePathForNodeJs(
      pluginsPaths["webpack"],
    )}");
    const TerserPlugin = require("${escapePathForNodeJs(
      pluginsPaths["terser-webpack-plugin"],
    )}");

    module.exports = {
      name: "aws-lambda-nodejs-webpack",
      mode: "none",
      entry: "${escapePathForNodeJs(entryFullPath)}",
      target: "node",
      resolve: {
        // next line allows resolving not found modules to local versions (require("lib/log"))
        modules: ["node_modules", "${escapePathForNodeJs(process.cwd())}"],
        extensions: [ ".ts", ".js" ],
        // fix for the crap that is Firebase
        // see https://github.com/firebase/firebase-js-sdk/issues/329#issuecomment-357117654
        mainFields: ["main"],
      },
      context: "${escapePathForNodeJs(process.cwd())}",
      devtool: "source-map",
      module: {
        rules: [
          {
            test: /\\.js$/,
            exclude: /node_modules/,
            use: {
              loader: "${escapePathForNodeJs(pluginsPaths["babel-loader"])}",
              options: {
                babelrc: false, // do not use babelrc when present (could pollute lambda configuration)
                cwd: "${escapePathForNodeJs(process.cwd())}",
                cacheDirectory: "${escapePathForNodeJs(
                  path.join(
                    process.cwd(),
                    "node_modules",
                    ".cache",
                    "aws-lambda-nodejs-webpack",
                    "babel",
                  ),
                )}",
                presets: [
                  [
                    "${escapePathForNodeJs(pluginsPaths["@babel/preset-env"])}",
                    {
                      "targets": {
                        "node": "${
                          runtime.name.split("nodejs")[1].split(".")[0]
                        }"
                      },
                      loose: true,
                      bugfixes: true,
                      ignoreBrowserslistConfig: true // do not use browser list configuration, we build for node X that's it
                    },
                  ]
                ],
                plugins: [
                  "${escapePathForNodeJs(
                    pluginsPaths["@babel/plugin-transform-runtime"],
                  )}",
                  "${escapePathForNodeJs(
                    pluginsPaths["babel-plugin-source-map-support"],
                  )}"
                ]
              }
            }
          },
          {
            test: /\\.ts$/,
            use: {
              loader: "${escapePathForNodeJs(
                findModulePath("ts-loader", pluginsPath),
              )}",
              options: {
                context: "${escapePathForNodeJs(process.cwd())}",
                configFile: "${escapePathForNodeJs(
                  path.join(process.cwd(), "tsconfig.json"),
                )}",
                transpileOnly: true,
                // from: https://www.npmjs.com/package/@tsconfig/node14
                compilerOptions: {
                  lib: ["es2020"],
                  module: "commonjs",
                  target: "es2020",
                  baseUrl: ".",
                  strict: true,
                  esModuleInterop: true,
                  skipLibCheck: true,
                  forceConsistentCasingInFileNames: true
                }
              }
            },
            exclude: /node_modules/,
          },
        ]
      },
      cache: {
        type: "filesystem",
        buildDependencies: {
          config: [__filename, "${escapePathForNodeJs(
            path.join(process.cwd(), "tsconfig.json"),
          )}"]
        },
        cacheDirectory: "${escapePathForNodeJs(
          path.join(
            process.cwd(),
            "node_modules",
            ".cache",
            "aws-lambda-nodejs-webpack",
            "webpack",
          ),
        )}"
      },
      // note: we specifically do not minify our code for Node.js
      // I have had horrible experience with code being minified for ES5 that would break on Node 12
      // If you have a good minifier that can minify to target Node 12 then open a PR
      optimization: {
        splitChunks: {
          cacheGroups: {
            vendor: {
              chunks: "all",
              filename: "vendor.js", // put all node_modules into vendor.js
              name: "vendor",
              test: /node_modules/,
            },
          },
        },
      },
      externals: [...builtinModules, ...${JSON.stringify([
        ...defaultExternals,
        ...userExternals,
      ])}],
      output: {
        filename: "[name].js",
        path: "${escapePathForNodeJs(outputDir)}",
        libraryTarget: "commonjs2",
      },
      ${(props.modulesToIgnore &&
        `
      plugins: [
        new NormalModuleReplacementPlugin(
          /${escapePathForNodeJs(props.modulesToIgnore.join("|"))}/,
          "${escapePathForNodeJs(pluginsPaths["noop2"])}",
        ),
      ]
      `) ||
        ""}
    };`;

    fs.writeFileSync(webpackConfigPath, webpackConfiguration);

    console.time(`aws-lambda-nodejs-webpack-${props.entry}`);
    const webpack = spawn.sync(
      webpackBinPath,
      ["--config", webpackConfigPath],
      {
        // we force CWD to the output dir to avoid being "polluted" by any babelrc or other configuration files
        // that could mess up with our own webpack configuration. If you need to reuse your babelrc then please open an issue
        cwd: outputDir,
      },
    );
    console.timeEnd(`aws-lambda-nodejs-webpack-${props.entry}`);

    if (webpack.status !== 0) {
      console.error(
        `webpack had an error when bundling. Return status was ${webpack.status}`,
      );
      console.error(webpack.error);
      console.error(
        webpack?.output?.map(out => {
          return out?.toString();
        }),
      );
      console.error("webpack configuration was:", webpackConfiguration);
      process.exit(1);
    }

    super(scope, id, {
      ...props,
      runtime,
      code: lambda.Code.fromAsset(outputDir),
      handler: `main.${handler}`,
    });

    // Enable connection reuse for aws-sdk
    if (props.awsSdkConnectionReuse ?? true) {
      this.addEnvironment("AWS_NODEJS_CONNECTION_REUSE_ENABLED", "1");
    }

    this.addEnvironment("NODE_OPTIONS", "--enable-source-maps");
  }
}

function nodeMajorVersion(): number {
  return parseInt(process.versions.node.split(".")[0], 10);
}

// this method forces resolving plugins relative to node_modules/aws-lambda-nodejs-webpack
// otherwise they would be resolved to the user versions / undefined versions
function findModulePath(moduleName: string, pluginsPath: string) {
  try {
    return require.resolve(moduleName, { paths: [__dirname] });
  } catch (error) {
    const modulePath = findUp.sync(moduleName, {
      type: "directory",
      cwd: pluginsPath,
    });

    if (modulePath === undefined) {
      throw new Error(
        `Can't find module named ${moduleName} via require.resolve or find-up`,
      );
    }

    return modulePath;
  }
}
