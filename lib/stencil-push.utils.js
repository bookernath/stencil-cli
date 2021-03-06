const _ = require('lodash');
const async = require('async');
const Inquirer = require('inquirer');
const ProgressBar = require('progress');
const uuid = require('uuid4');
const fetch = require('node-fetch');
const os = require('os');

const { THEME_PATH } = require('../constants');
const Bundle = require('./stencil-bundle');
const themeApiClient = require('./theme-api-client');
const ThemeConfig = require('./theme-config');
const { parseJsonFile } = require('./utils/fsUtils');

const themeConfig = ThemeConfig.getInstance(THEME_PATH);
const utils = {};

const bar = new ProgressBar('Processing [:bar] :percent; ETA: :etas', {
    complete: '=',
    incomplete: ' ',
    total: 100,
});

function validateOptions(options = {}, fields = []) {
    for (const field of fields) {
        if (!_.has(options, field)) {
            throw new Error(`${field} is required!`);
        }
    }
}

utils.readStencilConfigFile = async (options) => {
    validateOptions(options, ['dotStencilFilePath']);

    try {
        const config = await parseJsonFile(options.dotStencilFilePath);
        return { ...options, config };
    } catch (err) {
        err.name = 'StencilConfigReadError';
        throw err;
    }
};

utils.getStoreHash = async (options) => {
    validateOptions(options, ['config.normalStoreUrl']);

    const storeUrlObj = new URL(options.config.normalStoreUrl);

    try {
        const response = await fetch(`https://${storeUrlObj.host}/admin/oauth/info`);
        if (!response.ok) {
            throw new Error(response.statusText);
        }
        const payload = await response.json();
        if (!payload.store_hash) {
            throw new Error('Received empty store_hash value in the server response');
        }
        return { ...options, storeHash: payload.store_hash };
    } catch (err) {
        err.name = 'StoreHashReadError';
        throw err;
    }
};

utils.getThemes = async (options) => {
    const {
        config: { accessToken },
        apiHost,
        storeHash,
    } = options;

    const themes = await themeApiClient.getThemes({ accessToken, apiHost, storeHash });

    return { ...options, themes };
};

utils.generateBundle = async (options) => {
    if (options.bundleZipPath) {
        return options;
    }

    const output = options.saveBundleName
        ? { dest: THEME_PATH, name: options.saveBundleName }
        : { dest: os.tmpdir(), name: uuid() };
    const rawConfig = await themeConfig.getRawConfig();
    const bundle = new Bundle(THEME_PATH, themeConfig, rawConfig, output);

    try {
        const bundleZipPath = await bundle.initBundle();
        return { ...options, bundleZipPath };
    } catch (err) {
        err.name = 'BundleInitError';
        throw err;
    }
};

utils.uploadBundle = async (options) => {
    const {
        config: { accessToken },
        apiHost,
        bundleZipPath,
        storeHash,
    } = options;

    try {
        const result = await themeApiClient.postTheme({
            accessToken,
            apiHost,
            bundleZipPath,
            storeHash,
        });

        return {
            ...options,
            jobId: result.jobId,
            themeLimitReached: !!result.themeLimitReached,
        };
    } catch (err) {
        err.name = 'ThemeUploadError';
        throw err;
    }
};

utils.notifyUserOfThemeLimitReachedIfNecessary = async (options) => {
    if (options.themeLimitReached && !options.deleteOldest) {
        console.log(
            'warning'.yellow +
                ' -- You have reached your upload limit. ' +
                "In order to proceed, you'll need to delete at least one theme.",
        );
    }

    return options;
};

utils.promptUserToDeleteThemesIfNecessary = async (options) => {
    if (!options.themeLimitReached) {
        return options;
    }

    if (options.deleteOldest) {
        const oldestTheme = options.themes
            .filter((theme) => theme.is_private && !theme.is_active)
            .map((theme) => ({
                uuid: theme.uuid,
                updated_at: new Date(theme.updated_at).valueOf(),
            }))
            .reduce((prev, current) => (prev.updated_at < current.updated_at ? prev : current));

        return { ...options, themeIdsToDelete: [oldestTheme.uuid] };
    }

    const questions = [
        {
            choices: options.themes.map((theme) => ({
                disabled: theme.is_active || !theme.is_private,
                name: theme.name,
                value: theme.uuid,
            })),
            message: 'Which theme(s) would you like to delete?',
            name: 'themeIdsToDelete',
            type: 'checkbox',
            validate: (val) => {
                if (val.length > 0) {
                    return true;
                }
                return 'You must delete at least one theme';
            },
        },
    ];
    const answers = await Inquirer.prompt(questions);

    return { ...options, ...answers };
};

utils.deleteThemesIfNecessary = async (options) => {
    const {
        config: { accessToken },
        apiHost,
        storeHash,
        themeLimitReached,
        themeIdsToDelete,
    } = options;

    if (!themeLimitReached) {
        return options;
    }

    try {
        const promises = themeIdsToDelete.map((themeId) =>
            themeApiClient.deleteThemeById({ accessToken, apiHost, storeHash, themeId }),
        );
        await Promise.all(promises);
    } catch (err) {
        err.name = 'ThemeDeletionError';
        throw err;
    }

    return options;
};

utils.uploadBundleAgainIfNecessary = async (options) => {
    if (!options.themeLimitReached) {
        return options;
    }

    return utils.uploadBundle(options);
};

utils.notifyUserOfThemeUploadCompletion = async (options) => {
    console.log(`${'ok'.green} -- Theme Upload Finished`);

    return options;
};

utils.markJobProgressPercentage = (percentComplete) => {
    bar.update(percentComplete / 100);
};

utils.markJobComplete = () => {
    utils.markJobProgressPercentage(100);
    console.log(`${'ok'.green} -- Theme Processing Finished`);
};

utils.pollForJobCompletion = (resultFilter) => {
    return async.retryable(
        {
            interval: 1000,
            errorFilter: (err) => {
                if (err.name === 'JobCompletionStatusCheckPendingError') {
                    utils.markJobProgressPercentage(err.message);
                    return true;
                }

                return false;
            },
            times: Number.POSITIVE_INFINITY,
        },
        utils.checkIfJobIsComplete(resultFilter),
    );
};

utils.checkIfJobIsComplete = (resultFilter) => async (options) => {
    const {
        config: { accessToken },
        apiHost,
        storeHash,
        bundleZipPath,
        jobId,
    } = options;

    const result = await themeApiClient.getJob({
        accessToken,
        apiHost,
        storeHash,
        bundleZipPath,
        jobId,
        resultFilter,
    });

    utils.markJobComplete();

    return { ...options, ...result };
};

utils.promptUserWhetherToApplyTheme = async (options) => {
    if (options.activate) {
        return { ...options, applyTheme: true };
    }

    const questions = [
        {
            type: 'confirm',
            name: 'applyTheme',
            message: `Would you like to apply your theme to your store at ${options.config.normalStoreUrl}?`,
            default: false,
        },
    ];
    const answers = await Inquirer.prompt(questions);

    return { ...options, ...answers };
};

utils.getVariations = async (options) => {
    const {
        config: { accessToken },
        apiHost,
        storeHash,
        themeId,
        applyTheme,
        activate,
    } = options;

    if (!applyTheme) {
        return options;
    }

    const variations = await themeApiClient.getVariationsByThemeId({
        accessToken,
        apiHost,
        themeId,
        storeHash,
    });

    if (!activate && activate !== undefined) {
        const foundVariation = variations.find((item) => item.name === activate);

        if (!foundVariation || !foundVariation.uuid) {
            const availableOptionsStr = variations.map((item) => `${item.name}`).join(', ');
            throw new Error(
                `Invalid theme variation provided!. Available options ${availableOptionsStr}...`,
            );
        }

        return { ...options, variationId: foundVariation.uuid };
    }
    if (activate) {
        return { ...options, variationId: variations[0].uuid };
    }

    return { ...options, variations };
};

utils.promptUserForVariation = async (options) => {
    if (!options.applyTheme || options.variationId) {
        return options;
    }

    const questions = [
        {
            type: 'list',
            name: 'variationId',
            message: 'Which variation would you like to apply?',
            choices: options.variations.map((variation) => ({
                name: variation.name,
                value: variation.uuid,
            })),
        },
    ];
    const answers = await Inquirer.prompt(questions);

    return { ...options, ...answers };
};

utils.requestToApplyVariationWithRetrys = () => {
    return async.retryable(
        {
            interval: 1000,
            errorFilter: (err) => {
                if (err.name === 'VariationActivationTimeoutError') {
                    console.log(`${'warning'.yellow} -- Theme Activation Timed Out; Retrying...`);
                    return true;
                }

                return false;
            },
            times: 3,
        },
        utils.requestToApplyVariation,
    );
};

utils.requestToApplyVariation = async (options) => {
    const {
        config: { accessToken },
        apiHost,
        storeHash,
        variationId,
    } = options;

    if (options.applyTheme) {
        await themeApiClient.activateThemeByVariationId({
            accessToken,
            apiHost,
            storeHash,
            variationId,
        });
    }

    return options;
};

utils.notifyUserOfCompletion = (options, callback) => {
    callback(null, 'Stencil Push Finished');
};

module.exports = utils;
