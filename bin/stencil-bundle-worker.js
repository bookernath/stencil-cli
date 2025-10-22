#!/usr/bin/env node
import 'colors';
import program from '../lib/commander.js';
import { THEME_PATH, PACKAGE_INFO } from '../constants.js';
import ThemeConfig from '../lib/theme-config.js';
import WorkerBundle from '../lib/stencil-bundle-worker.js';
import { printCliResultErrorAndExit, prepareCommand } from '../lib/cliCommon.js';

program
    .version(PACKAGE_INFO.version)
    .option(
        '-d, --dest [dest]',
        'Where to save the worker bundle. It defaults to a "worker-bundle" directory',
    )
    .option(
        '-t, --timeout [timeout]',
        'Set a timeout for the bundle operation. Default is 60 secs',
        '60',
    )
    .option(
        '--api-url [apiUrl]',
        'The base API URL for the BigCommerce store (e.g., https://store-abc123.mybigcommerce.com)',
    );

const cliOptions = prepareCommand(program);
const themeConfig = ThemeConfig.getInstance(THEME_PATH);

async function run() {
    try {
        if (cliOptions.dest === true) {
            throw new Error('You have to specify a value for -d or --dest'.red);
        }

        if (!themeConfig.configExists()) {
            throw new Error(
                `${
                    'You must have a '.red + 'config.json'.cyan
                } file in your top level theme directory.`,
            );
        }

        const rawConfig = await themeConfig.getRawConfig();

        const workerBundle = new WorkerBundle(
            THEME_PATH,
            themeConfig,
            rawConfig,
            cliOptions,
        );

        const bundlePath = await workerBundle.initBundle();
        console.log(`${'ok'.green} -- Worker bundle saved to: ${bundlePath.cyan}`);
        console.log(`\nTo test locally, run: ${'cd'.cyan} ${bundlePath.cyan} ${'&& wrangler dev'.cyan}`);
    } catch (err) {
        printCliResultErrorAndExit(err);
    }
}

run();
