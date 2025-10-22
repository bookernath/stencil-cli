import path from 'path';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import async from 'async';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import BundleValidator from './bundle-validator.js';
import langAssembler from './lang-assembler.js';
import templateAssembler from './template-assembler.js';
import { recursiveReadDir } from './utils/fsUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class WorkerBundle {
    constructor(
        themePath,
        themeConfig,
        rawConfig,
        options = {},
    ) {
        this.options = options;
        this.themePath = themePath;
        this.themeConfig = themeConfig;
        this.configuration = rawConfig;
        this.templatesPath = path.join(themePath, 'templates');
        this.validator = new BundleValidator(this.themePath, this.themeConfig, true);
    }

    async initBundle() {
        try {
            console.log('Starting Cloudflare Worker bundle process...');

            // Validate theme
            await this._validateTheme();

            // Create output directory
            const outputDir = this.options.dest || path.join(this.themePath, 'worker-bundle');
            await fsPromises.mkdir(outputDir, { recursive: true });

            // Assemble templates
            console.log('Template Parsing Started...');
            const templates = await this._assembleTemplates();
            console.log(`${'ok'.green} -- Template Parsing Finished`);

            // Assemble language files
            console.log('Language Files Parsing Started...');
            const translations = await this._assembleLang();
            console.log(`${'ok'.green} -- Language Files Parsing Finished`);

            // Get schema
            console.log('Building Theme Schema...');
            const schema = await this.themeConfig.getSchema();
            console.log(`${'ok'.green} -- Theme Schema Building Finished`);

            // Get theme config
            const configuration = await this.themeConfig.getConfig();

            // Generate package.json for worker FIRST
            await this._generateWorkerPackageJson(outputDir);

            // Install dependencies
            console.log('Installing worker dependencies...');
            await this._installWorkerDependencies(outputDir);
            console.log(`${'ok'.green} -- Dependencies Installed`);

            // Generate the worker script
            console.log('Generating Worker Script...');
            await this._generateWorkerScript(outputDir, templates, translations, schema, configuration);
            console.log(`${'ok'.green} -- Worker Script Generation Finished`);

            // Copy assets
            console.log('Copying Assets...');
            await this._copyAssets(outputDir);
            console.log(`${'ok'.green} -- Assets Copying Finished`);

            // Generate wrangler.toml
            console.log('Generating Wrangler Configuration...');
            await this._generateWranglerConfig(outputDir);
            console.log(`${'ok'.green} -- Wrangler Configuration Generated`);

            return outputDir;
        } catch (err) {
            const errorMessage = err.message ? err.message : String(err);
            console.error('failed  -- '.red + errorMessage.red);
            throw err;
        }
    }

    async _validateTheme() {
        console.log('Validating theme...');
        return new Promise((resolve, reject) => {
            this.validator.validateTheme((err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(true);
                }
            });
        });
    }

    async _assembleTemplates() {
        const internalTemplatesList = await recursiveReadDir(this.templatesPath, ['!*.html']);

        // Get external libraries
        const getExternalLibs = async (templatePath) => {
            const content = await fsPromises.readFile(templatePath, { encoding: 'utf-8' });
            const externalPathRegex = /{{2}>\s*(['"]external)[^{]*?}{2}/g;
            const externalTemplatesImports = content.match(externalPathRegex);
            if (!externalTemplatesImports) return [];

            return externalTemplatesImports.map((templateImport) => {
                const [, importPath] = templateAssembler.partialRegex.exec(templateImport);
                templateAssembler.partialRegex.lastIndex = 0;
                return importPath
                    .split('/templates/')[0]
                    .slice(templateAssembler.packageMarker.length + 1);
            });
        };

        const removeDuplicates = (arr) => Array.from(new Set(arr.flat()));
        const temp = internalTemplatesList.map(getExternalLibs);
        const result = await Promise.all(temp);
        const externalLibs = removeDuplicates(result);

        let externalLibPaths = [];
        if (externalLibs.length) {
            externalLibPaths = externalLibs.map((lib) =>
                recursiveReadDir(path.join(this.themePath, 'node_modules', lib, 'templates'), [
                    '!*.html',
                ]),
            );
        }

        const res = await Promise.allSettled([
            recursiveReadDir(this.templatesPath, ['!*.html']),
            ...externalLibPaths,
        ]);

        const [{ value: internalTemplates }, ...externalTemplatesList] = res;

        const internalPartials = internalTemplates.map((file) => {
            return file
                .replace(this.templatesPath + path.sep, '')
                .replace(/\.html$/, '')
                .replace(/\\/g, '/');
        });

        const externalPartials = externalTemplatesList.reduce(
            (partials, { value: externalTemplates }) => {
                const extractedPartials = externalTemplates.map((file) => {
                    return ('external' + file.split('node_modules')[1].replace(/\.html$/, ''))
                        .replace(/\\/g, '/');
                });
                partials.push(...extractedPartials);
                return partials;
            },
            [],
        );

        const allPartials = [...externalPartials, ...internalPartials];

        const results = await async.map(
            allPartials,
            templateAssembler.assembleAndBundle.bind(null, this.templatesPath),
        );

        const ret = {};
        allPartials.forEach((file, index) => {
            ret[file] = results[index];
        });

        return ret;
    }

    async _assembleLang() {
        return new Promise((resolve, reject) => {
            langAssembler.assemble((err, results) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(results);
                }
            });
        });
    }

    async _generateWorkerScript(outputDir, templates, translations, schema, configuration) {
        // Pre-compile templates to JavaScript functions (no eval needed!)
        console.log('Pre-compiling templates to JavaScript functions...');
        await this._generateStaticTemplates(outputDir, templates);

        // Read the worker entry template
        const workerTemplatePath = path.join(__dirname, '../templates/worker-entry.js');

        let workerTemplate;
        try {
            workerTemplate = await fsPromises.readFile(workerTemplatePath, 'utf-8');
        } catch (err) {
            // If template doesn't exist, use inline template
            workerTemplate = this._getInlineWorkerTemplate();
        }

        // Replace placeholders in template
        const apiUrl = this.options.apiUrl || 'https://stencil-on-workers.store';
        const workerScript = workerTemplate
            .replace('__TRANSLATIONS_DATA__', JSON.stringify(translations, null, 2))
            .replace('__SCHEMA_DATA__', JSON.stringify(schema, null, 2))
            .replace('__CONFIG_DATA__', JSON.stringify(configuration, null, 2))
            .replace('__API_URL__', apiUrl);

        // Write the source worker script
        const sourceWorkerPath = path.join(outputDir, 'worker.source.js');
        await fsPromises.writeFile(sourceWorkerPath, workerScript);

        // Bundle with esbuild
        console.log('Bundling worker with esbuild...');
        await this._bundleWorkerWithEsbuild(outputDir, sourceWorkerPath);

        // Clean up source file
        await fsPromises.unlink(sourceWorkerPath);
        console.log(`${'ok'.green} -- Worker bundling complete`);
    }

    async _generateStaticTemplates(outputDir, templates) {
        // Import Handlebars to pre-compile templates
        const Handlebars = await import('handlebars');

        const handlebarsOptions = {
            preventIndent: true,
            knownHelpers: {},
            knownHelpersOnly: false,
        };

        let templateFunctions = '// Pre-compiled template functions - NO EVAL!\n';
        templateFunctions += 'import Handlebars from \'handlebars/runtime\';\n\n';

        const templateExports = [];

        for (const [templateName, templateData] of Object.entries(templates)) {
            // The template data might be a string (template source) or an object with the source
            // and its dependencies. We need the actual template source string.
            let templateSource;

            if (typeof templateData === 'string') {
                templateSource = templateData;
            } else if (typeof templateData === 'object' && templateData !== null) {
                // If it's an object, the main template is usually under the template name key
                templateSource = templateData[templateName];

                if (!templateSource) {
                    console.warn(`Skipping ${templateName}: no template source found in object`);
                    continue;
                }
            } else {
                console.warn(`Skipping ${templateName}: unexpected data type ${typeof templateData}`);
                continue;
            }

            // Create a safe function name from the template name
            const safeName = templateName.replace(/[^a-zA-Z0-9]/g, '_');
            const functionName = `template_${safeName}`;

            try {
                // Pre-compile the template at BUILD time
                const precompiled = Handlebars.default.precompile(templateSource, handlebarsOptions);

                // Instead of storing the string, we write it as actual JavaScript code
                templateFunctions += `// Template: ${templateName}\n`;
                templateFunctions += `const ${functionName} = Handlebars.template(${precompiled});\n\n`;

                templateExports.push({
                    name: templateName,
                    functionName: functionName
                });
            } catch (err) {
                console.error(`Error pre-compiling template ${templateName}:`, err.message);
                throw err;
            }
        }

        // Create the export mapping
        templateFunctions += '// Export mapping of template names to functions\n';
        templateFunctions += 'export default {\n';
        for (const { name, functionName } of templateExports) {
            templateFunctions += `  '${name}': ${functionName},\n`;
        }
        templateFunctions += '};\n';

        // Write the static templates module
        const templatesModulePath = path.join(outputDir, 'templates.js');
        await fsPromises.writeFile(templatesModulePath, templateFunctions);
        console.log(`${'ok'.green} -- Pre-compiled ${templateExports.length} templates to static functions`);
    }

    async _bundleWorkerWithEsbuild(outputDir, sourceWorkerPath) {
        try {
            // Dynamically import esbuild and plugins
            const esbuild = await import('esbuild');
            const { NodeGlobalsPolyfillPlugin } = await import('@esbuild-plugins/node-globals-polyfill');
            const { NodeModulesPolyfillPlugin } = await import('@esbuild-plugins/node-modules-polyfill');

            // Create a plugin to use Handlebars runtime instead of full compiler
            const { createRequire } = await import('module');
            const require2 = createRequire(import.meta.url);

            const handlebarsRuntimePlugin = {
                name: 'handlebars-runtime',
                setup(build) {
                    // Redirect 'handlebars' imports to 'handlebars/runtime' (no eval)
                    build.onResolve({ filter: /^handlebars$/ }, args => {
                        return {
                            path: require2.resolve('handlebars/runtime'),
                        };
                    });

                    // Also handle @bigcommerce/handlebars-v4
                    build.onResolve({ filter: /^@bigcommerce\/handlebars-v4$/ }, args => {
                        // Try to use runtime if available, otherwise use full version
                        try {
                            return {
                                path: require2.resolve('@bigcommerce/handlebars-v4/runtime'),
                            };
                        } catch (e) {
                            // If no runtime available, use the full version (will warn about eval)
                            return {
                                path: require2.resolve('@bigcommerce/handlebars-v4'),
                            };
                        }
                    });
                },
            };

            // Create a plugin to replace dynamic requires with static imports
            const staticHelpersPlugin = {
                name: 'static-helpers',
                setup(build) {
                    // Intercept the main helpers.js module to use static imports
                    build.onLoad({ filter: /stencil-paper-handlebars\/helpers\.js$/ }, async (args) => {
                        const staticHelpersIndex = `
// Static version of helpers index - no dynamic requires
import all from './helpers/all.js';
import any from './helpers/any.js';
import assignVar from './helpers/assignVar.js';
import block from './helpers/block.js';
import cdn from './helpers/cdn.js';
import compare from './helpers/compare.js';
import concat from './helpers/concat.js';
import contains from './helpers/contains.js';
import decrementVar from './helpers/decrementVar.js';
import dynamicComponent from './helpers/dynamicComponent.js';
import encodeHtmlEntities from './helpers/encodeHtmlEntities.js';
import forHelper from './helpers/for.js';
import get from './helpers/get.js';
import getContentImage from './helpers/getContentImage.js';
import getContentImageSrcset from './helpers/getContentImageSrcset.js';
import getFontLoaderConfig from './helpers/getFontLoaderConfig.js';
import getFontsCollection from './helpers/getFontsCollection.js';
import getImage from './helpers/getImage.js';
import getImageManagerImage from './helpers/getImageManagerImage.js';
import getImageManagerImageSrcset from './helpers/getImageManagerImageSrcset.js';
import getImageSrcset from './helpers/getImageSrcset.js';
import getImageSrcset1x2x from './helpers/getImageSrcset1x2x.js';
import getObject from './helpers/getObject.js';
import getVar from './helpers/getVar.js';
import helperMissing from './helpers/helperMissing.js';
import ifHelper from './helpers/if.js';
import incrementVar from './helpers/incrementVar.js';
import inject from './helpers/inject.js';
import join from './helpers/join.js';
import jsContext from './helpers/jsContext.js';
import json from './helpers/json.js';
import jsonParseSafe from './helpers/jsonParseSafe.js';
import lang from './helpers/lang.js';
import langJson from './helpers/langJson.js';
import limit from './helpers/limit.js';
import moment from './helpers/moment.js';
import money from './helpers/money.js';
import multiConcat from './helpers/multiConcat.js';
import nl2br from './helpers/nl2br.js';
import occurrences from './helpers/occurrences.js';
import option from './helpers/option.js';
import or from './helpers/or.js';
import partial from './helpers/partial.js';
import pluck from './helpers/pluck.js';
import pre from './helpers/pre.js';
import region from './helpers/region.js';
import replace from './helpers/replace.js';
import resourceHints from './helpers/resourceHints.js';
import setURLQueryParam from './helpers/setURLQueryParam.js';
import snippets from './helpers/snippets.js';
import stripQuerystring from './helpers/stripQuerystring.js';
import strReplace from './helpers/strReplace.js';
import stylesheet from './helpers/stylesheet.js';
import thirdParty from './helpers/thirdParty.js';
import toLowerCase from './helpers/toLowerCase.js';
import truncate from './helpers/truncate.js';
import unless from './helpers/unless.js';
import earlyHint from './helpers/earlyHint.js';
import nonce from './helpers/nonce.js';
import typeofHelper from './helpers/typeof.js';

// Deprecated helpers
import enumerate from './helpers/deprecated/enumerate.js';
import equals from './helpers/deprecated/equals.js';
import getShortMonth from './helpers/deprecated/getShortMonth.js';
import pick from './helpers/deprecated/pick.js';

const helpers = [
    ...all,
    ...any,
    ...assignVar,
    ...block,
    ...cdn,
    ...compare,
    ...concat,
    ...contains,
    ...decrementVar,
    ...dynamicComponent,
    ...encodeHtmlEntities,
    ...forHelper,
    ...get,
    ...getContentImage,
    ...getContentImageSrcset,
    ...getFontLoaderConfig,
    ...getFontsCollection,
    ...getImage,
    ...getImageManagerImage,
    ...getImageManagerImageSrcset,
    ...getImageSrcset,
    ...getImageSrcset1x2x,
    ...getObject,
    ...getVar,
    ...helperMissing,
    ...ifHelper,
    ...incrementVar,
    ...inject,
    ...join,
    ...jsContext,
    ...json,
    ...jsonParseSafe,
    ...lang,
    ...langJson,
    ...limit,
    ...moment,
    ...money,
    ...multiConcat,
    ...nl2br,
    ...occurrences,
    ...option,
    ...or,
    ...partial,
    ...pluck,
    ...pre,
    ...region,
    ...replace,
    ...resourceHints,
    ...setURLQueryParam,
    ...snippets,
    ...stripQuerystring,
    ...strReplace,
    ...stylesheet,
    ...thirdParty,
    ...toLowerCase,
    ...truncate,
    ...unless,
    ...earlyHint,
    ...nonce,
    ...typeofHelper,
    ...enumerate,
    ...equals,
    ...getShortMonth,
    ...pick,
];

export default helpers;
`;
                        return {
                            contents: staticHelpersIndex,
                            loader: 'js',
                        };
                    });

                    // Intercept the thirdParty.js module and replace it with a static version
                    build.onLoad({ filter: /helpers\/thirdParty\.js$/ }, async (args) => {
                        const staticHelpers = `
// Static version of thirdParty helpers - no dynamic requires
import arrayHelpers from './3p/array.js';
import collectionHelpers from './3p/collection.js';
import comparisonHelpers from './3p/comparison.js';
import htmlHelpers from './3p/html.js';
import inflectionHelpers from './3p/inflection.js';
import markdownHelpers from './3p/markdown.js';
import mathHelpers from './3p/math.js';
import numberHelpers from './3p/number.js';
import objectHelpers from './3p/object.js';
import stringHelpers from './3p/string.js';
import urlHelpers from './3p/url.js';

const modules = {
    'array': arrayHelpers,
    'collection': collectionHelpers,
    'comparison': comparisonHelpers,
    'html': htmlHelpers,
    'inflection': inflectionHelpers,
    'markdown': markdownHelpers,
    'math': mathHelpers,
    'number': numberHelpers,
    'object': objectHelpers,
    'string': stringHelpers,
    'url': urlHelpers,
};

const whitelist = [
    {
        name: 'array',
        include: [
            'after', 'arrayify', 'before', 'eachIndex', 'filter', 'first',
            'forEach', 'inArray', 'isArray', 'last', 'lengthEqual', 'map',
            'some', 'sort', 'sortBy', 'withAfter', 'withBefore', 'withFirst',
            'withLast', 'withSort',
        ],
    },
    {
        name: 'collection',
        include: ['isEmpty', 'iterate', 'length'],
    },
    {
        name: 'comparison',
        include: [
            'and', 'gt', 'gte', 'has', 'eq', 'ifEven', 'ifNth', 'ifOdd',
            'is', 'isnt', 'lt', 'lte', 'neither', 'unlessEq', 'unlessGt',
            'unlessLt', 'unlessGteq', 'unlessLteq',
        ],
    },
    {
        name: 'html',
        include: ['ellipsis', 'sanitize', 'ul', 'ol', 'thumbnailImage']
    },
    {
        name: 'inflection',
        include: ['inflect', 'ordinalize'],
    },
    {
        name: 'markdown',
        include: ['markdown'],
    },
    {
        name: 'math',
        include: ['add', 'subtract', 'divide', 'multiply', 'floor', 'ceil', 'round', 'sum', 'avg'],
    },
    {
        name: 'number',
        include: [
            'addCommas', 'phoneNumber', 'random', 'toAbbr', 'toExponential',
            'toFixed', 'toFloat', 'toInt', 'toPrecision',
        ],
    },
    {
        name: 'object',
        include: [
            'extend', 'forIn', 'forOwn', 'toPath', 'hasOwn', 'isObject',
            'merge', 'JSONparse', 'JSONstringify',
        ],
    },
    {
        name: 'string',
        include: [
            'camelcase', 'capitalize', 'capitalizeAll', 'center', 'chop',
            'dashcase', 'dotcase', 'hyphenate', 'isString', 'lowercase',
            'pascalcase', 'pathcase', 'plusify', 'reverse', 'sentence',
            'snakecase', 'split', 'startsWith', 'titleize', 'trim', 'uppercase'
        ],
    },
    {
        name: 'url',
        include: ['encodeURI', 'decodeURI', 'urlResolve', 'urlParse', 'stripProtocol'],
    },
];

const exportedHelpers = [];
for (let i = 0; i < whitelist.length; i++) {
    const spec = whitelist[i];
    const module = modules[spec.name];

    if (!module) {
        console.warn('Missing module:', spec.name);
        continue;
    }

    const moduleWhitelist = spec.include;
    for (let i = 0; i < moduleWhitelist.length; i++) {
        const name = moduleWhitelist[i];
        exportedHelpers.push({
            name: name,
            factory: () => module[name],
        });
    }
}

export default exportedHelpers;
`;
                        return {
                            contents: staticHelpers,
                            loader: 'js',
                        };
                    });
                },
            };

            await esbuild.build({
                entryPoints: [sourceWorkerPath],
                bundle: true,
                outfile: path.join(outputDir, 'worker.js'),
                format: 'esm',
                platform: 'browser',
                target: 'es2022',
                mainFields: ['browser', 'module', 'main'],
                conditions: ['worker', 'browser'],
                // Look for node_modules in the output directory
                nodePaths: [path.join(outputDir, 'node_modules')],
                // External modules that are provided by Cloudflare Workers runtime
                external: [],
                // Define node globals
                define: {
                    'process.env.NODE_ENV': '"production"',
                    'global': 'globalThis',
                },
                // Use polyfill plugins
                plugins: [
                    // handlebarsRuntimePlugin,  // Disabled for now - causes precompile errors
                    staticHelpersPlugin,
                    NodeModulesPolyfillPlugin(),
                    NodeGlobalsPolyfillPlugin({
                        process: true,
                        buffer: true,
                    }),
                ],
                minify: false, // Keep unminified for debugging
                sourcemap: false,
                logLevel: 'info',
            });
        } catch (err) {
            console.error('esbuild bundling failed:', err);
            throw err;
        }
    }

    _getInlineWorkerTemplate() {
        return `// Cloudflare Worker for Stencil Theme Rendering
// This worker handles rendering Stencil templates at the edge

// All templates are pre-compiled - NO EVAL!
import TEMPLATE_FUNCTIONS from './templates.js';
import Handlebars from 'handlebars/runtime';
import helpers from '@bigcommerce/stencil-paper-handlebars/helpers.js';

// Data - will be replaced during build
const TRANSLATIONS = __TRANSLATIONS_DATA__;
const SCHEMA = __SCHEMA_DATA__;
const CONFIG = __CONFIG_DATA__;
const API_BASE_URL = '__API_URL__';

// Register all helpers with Handlebars
helpers.forEach(helper => {
    if (helper.name && helper.factory) {
        const helperFunc = typeof helper.factory === 'function' ? helper.factory() : helper.factory;
        Handlebars.registerHelper(helper.name, helperFunc);
    }
});

export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);

            // Make request to downstream API to get stencil context
            const apiUrl = new URL(url.pathname + url.search, API_BASE_URL);
            const apiRequest = new Request(apiUrl.toString(), {
                method: request.method,
                headers: {
                    ...Object.fromEntries(request.headers),
                    'X-BC-Json-Context': 'storefront',
                },
            });

            const apiResponse = await fetch(apiRequest);

            // Check if we got JSON context back
            const contentType = apiResponse.headers.get('content-type') || '';
            if (!contentType.includes('application/json')) {
                // Not a stencil context, just pass through
                return apiResponse;
            }

            const stencilData = await apiResponse.json();

            // Check if this is a stencil context (has template_file)
            if (!stencilData.template_file) {
                // Not a stencil context, just pass through
                return new Response(JSON.stringify(stencilData), {
                    headers: { 'content-type': 'application/json' },
                });
            }

            // Render the template
            const html = await renderTemplate(stencilData, request);

            return new Response(html, {
                headers: {
                    'content-type': 'text/html;charset=UTF-8',
                },
            });
        } catch (err) {
            console.error('Worker error:', err);
            return new Response('Internal Server Error: ' + err.message, {
                status: 500,
                headers: { 'content-type': 'text/plain' },
            });
        }
    },
};

async function renderTemplate(stencilData, request) {
    // Get template path from the response
    const templatePath = stencilData.template_file || 'pages/home';

    // Get the pre-compiled template function (NO EVAL!)
    const templateFunc = TEMPLATE_FUNCTIONS[templatePath];
    if (!templateFunc) {
        throw new Error(\`Template not found: \${templatePath}\`);
    }

    // Prepare the rendering context
    const context = {
        ...stencilData,
        theme_settings: stencilData.theme_settings || CONFIG.settings || {},
        settings: stencilData.settings || {},
    };

    // Render the template directly using pre-compiled functions
    const html = templateFunc(context, {
        helpers: Handlebars.helpers,
        partials: TEMPLATE_FUNCTIONS,
        decorators: Handlebars.decorators,
    });

    return html;
}
`;
    }

    async _copyAssets(outputDir) {
        const assetsDir = path.join(this.themePath, 'assets');
        const targetAssetsDir = path.join(outputDir, 'assets');

        // Create assets directory
        await fsPromises.mkdir(targetAssetsDir, { recursive: true });

        // Copy CSS files for worker assets
        const distCssPath = path.join(assetsDir, 'dist');
        if (fs.existsSync(distCssPath)) {
            const targetCssPath = path.join(targetAssetsDir, 'dist');
            await this._copyDirectory(distCssPath, targetCssPath);
        }

        // Copy other static assets
        const staticPaths = ['fonts', 'img', 'icons'];
        for (const staticPath of staticPaths) {
            const sourcePath = path.join(assetsDir, staticPath);
            if (fs.existsSync(sourcePath)) {
                const targetPath = path.join(targetAssetsDir, staticPath);
                await this._copyDirectory(sourcePath, targetPath);
            }
        }
    }

    async _copyDirectory(source, target) {
        await fsPromises.mkdir(target, { recursive: true });

        const files = await fsPromises.readdir(source);
        for (const file of files) {
            const sourcePath = path.join(source, file);
            const targetPath = path.join(target, file);
            const stat = await fsPromises.stat(sourcePath);

            if (stat.isDirectory()) {
                await this._copyDirectory(sourcePath, targetPath);
            } else {
                await fsPromises.copyFile(sourcePath, targetPath);
            }
        }
    }

    async _generateWranglerConfig(outputDir) {
        const apiUrl = this.options.apiUrl || 'https://stencil-on-workers.store';
        const config = `name = "stencil-worker"
main = "worker.js"
compatibility_date = "2024-10-01"
compatibility_flags = ["nodejs_compat"]

# Assets configuration for serving static files
[assets]
directory = "./assets"

# Environment variables
[vars]
API_BASE_URL = "${apiUrl}"

# Observability configuration
[observability.logs]
enabled = true
head_sampling_rate = 1
invocation_logs = true
`;

        await fsPromises.writeFile(path.join(outputDir, 'wrangler.toml'), config);
    }

    async _generateWorkerPackageJson(outputDir) {
        const packageJson = {
            name: 'stencil-worker',
            version: '1.0.0',
            type: 'module',
            description: 'Cloudflare Worker for Stencil theme rendering',
            main: 'worker.js',
            scripts: {
                deploy: 'wrangler deploy',
                dev: 'wrangler dev',
            },
            dependencies: {
                '@bigcommerce/stencil-paper': this._getPaperVersion(),
                '@bigcommerce/stencil-paper-handlebars': this._getPaperHandlebarsVersion(),
            },
        };

        await fsPromises.writeFile(
            path.join(outputDir, 'package.json'),
            JSON.stringify(packageJson, null, 2),
        );
    }

    async _installWorkerDependencies(outputDir) {
        return new Promise((resolve, reject) => {
            const installProcess = execSync('npm install --omit=dev --loglevel=error', {
                cwd: outputDir,
                stdio: 'inherit',
            });
            resolve();
        });
    }

    _getPaperVersion() {
        try {
            const paperPackageJson = JSON.parse(
                fs.readFileSync(path.join(this.themePath, '../paper/package.json'), 'utf-8')
            );
            return paperPackageJson.version || '^5.3.0';
        } catch (err) {
            return '^5.3.0';
        }
    }

    _getPaperHandlebarsVersion() {
        try {
            const paperHandlebarsPackageJson = JSON.parse(
                fs.readFileSync(path.join(this.themePath, '../paper-handlebars/package.json'), 'utf-8')
            );
            return paperHandlebarsPackageJson.version || '^6.4.1';
        } catch (err) {
            return '^6.4.1';
        }
    }
}

export default WorkerBundle;
