// Cloudflare Worker for Stencil Theme Rendering
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
// Create the globals object that helpers expect (similar to what Paper provides)
const globals = {
    handlebars: Handlebars,
    getThemeSettings: () => CONFIG.settings || {},
    getSiteSettings: () => CONFIG.settings || {},
    getContentServiceContext: () => ({}),
    getRequestParams: () => ({}),
    getTranslator: () => {
        // Return a translator object that matches the Paper Translator interface
        const locale = 'en'; // Default locale
        return {
            translate: (key, parameters) => {
                // Simple translation - just return the key from translations or the key itself
                const translation = TRANSLATIONS[locale]?.[key] || key;
                // For simplicity, we're not handling MessageFormat parameters in the worker
                return translation;
            },
            getLocale: () => locale,
            getLanguage: (keyFilter) => {
                // Return the language object with translations
                // If keyFilter is provided, filter translations by key prefix
                const allTranslations = TRANSLATIONS[locale] || {};
                if (keyFilter) {
                    const filtered = {};
                    Object.keys(allTranslations).forEach(key => {
                        if (key.startsWith(keyFilter)) {
                            filtered[key] = allTranslations[key];
                        }
                    });
                    return { translations: filtered, locale };
                }
                return { translations: allTranslations, locale };
            },
        };
    },
    getContent: () => ({}), // Returns content regions (widgets)
    getLogger: () => console, // Returns a logger object
    cdnify: (path) => path,
    getImageManagerImage: (stencilImage, size) => stencilImage?.data || '',
    getContentImage: (path, size) => path,
    getOptimizedSrc: (src) => src,
    storage: {}, // Global storage used by helpers to keep state
    resourceHints: [], // Array for resource hints
};

// Register helpers
helpers.forEach(helper => {
    if (helper.name && helper.factory) {
        // Many helpers expect a globals object to be passed to their factory
        const helperFunc = typeof helper.factory === 'function' ? helper.factory(globals) : helper.factory;
        Handlebars.registerHelper(helper.name, helperFunc);
    }
});

// Register all template functions as partials
Object.keys(TEMPLATE_FUNCTIONS).forEach(templateName => {
    Handlebars.registerPartial(templateName, TEMPLATE_FUNCTIONS[templateName]);
});

// MIME type mapping for common file extensions
const MIME_TYPES = {
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    '.xml': 'application/xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.map': 'application/json',
};

function getMimeType(pathname) {
    const ext = pathname.substring(pathname.lastIndexOf('.')).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

export default {
    async fetch(request, env, ctx) {
        try {
            const url = new URL(request.url);

            // Exempt static asset and content paths - proxy them directly
            if (url.pathname.startsWith('/assets/') ||
                url.pathname.startsWith('/content/')) {
                const apiUrl = new URL(url.pathname + url.search, API_BASE_URL);
                const response = await fetch(apiUrl.toString(), {
                    method: request.method,
                    headers: request.headers,
                });

                // Fix MIME type based on file extension
                const correctMimeType = getMimeType(url.pathname);
                const headers = new Headers(response.headers);
                headers.set('content-type', correctMimeType);

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: headers,
                });
            }

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
        throw new Error(`Template not found: ${templatePath}`);
    }

    // Prepare the rendering context
    const context = {
        ...stencilData,
        theme_settings: stencilData.theme_settings || CONFIG.settings || {},
        settings: stencilData.settings || {},
    };

    // Render the template directly using pre-compiled functions
    // Provide the proper Handlebars container with decorator storage
    const html = templateFunc(context, {
        data: {}, // Handlebars private data context
        decorators: Handlebars.decorators,
        helpers: Handlebars.helpers,
        partials: Handlebars.partials,
    });

    return html;
}
