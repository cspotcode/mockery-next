/*
 Copyrights for code authored by Yahoo! Inc. is licensed under the following
 terms:

 MIT License

 Copyright (c) 2011-2012 Yahoo! Inc. All Rights Reserved.

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to
 deal in the Software without restriction, including without limitation the
 rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 sell copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 DEALINGS IN THE SOFTWARE.
*/

/*
 * A library that enables the hooking of the standard 'require' function, such
 * that a (possibly partial) mock implementation can be provided instead. This
 * is most useful for running unit tests, since any dependency obtained through
 * 'require' can be mocked out.
 */

"use strict";

var m = require('module'),
    registeredMocks = blank(),
    registeredSubstitutes = blank(),
    registeredAllowables = blank(),
    originalLoader = null,
    originalCache = null,
    defaultOptions = {
        useCleanCache: false,
        warnOnReplace: true,
        warnOnUnregistered: true
    },
    options = blank(),
    // Regexp matches IDs of native modules
    matchNativeModuleId = /\.node$/;

// Safe hasOwnProperty
function has(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
}

// Create an empty object with null prototype.  Useful as a dictionary.
function blank() {
    return Object.create(null);
}

function createModuleNotFoundError(request) {
    var err = new Error("Cannot find module '" + request + "'");
    err.code = 'MODULE_NOT_FOUND';
    return err;
}

function createInstance(parentModule) {

    /*
     * Merge the supplied options in with a new copy of the default options to get
     * the effective options, and return those.
     */
    function getEffectiveOptions(opts) {
        var options = blank();

        Object.keys(defaultOptions).forEach(function (key) {
            options[key] = defaultOptions[key];
        });
        if (opts) {
            Object.keys(opts).forEach(function (key) {
                options[key] = opts[key];
            });
        }
        return options;
    }

    /*
     * The (private) loader replacement that is used when hooking is enabled. It
     * does the work of returning a mock or substitute when configured, reporting
     * non-allowed modules, and invoking the original loader when appropriate.
     * The signature of this function *must* match that of Node's Module._load,
     * since it will replace that when mockery is enabled.
     */
    function hookedLoader(request, parent, isMain) {
        var subst, allow;

        if (!originalLoader) {
            throw new Error("Loader has not been hooked");
        }

        var path = m._resolveFilename(request, parent);

        if (has(registeredMocks, path)) {
            return registeredMocks[path];
        }

        if (has(registeredSubstitutes, path)) {
            subst = registeredSubstitutes[path];
            if(subst.name === null) {
                throw createModuleNotFoundError(request);
            }
            subst.module = originalLoader(subst.name, subst.parent, isMain);
            return subst.module;
        }

        if (has(registeredAllowables, path)) {
            allow = registeredAllowables[path];
            if (allow.unhook) {
                if (path.indexOf('/') !== -1 && allow.paths.indexOf(path) === -1) {
                    allow.paths.push(path);
                }
            }
        } else {
            if (options.warnOnUnregistered) {
                console.warn("WARNING: loading non-allowed module: " + request);
            }
        }

        return originalLoader(request, parent, isMain);
    }

    /*
     * Enables mockery by hooking subsequent 'require' invocations. Note that *all*
     * 'require' invocations will be hooked until 'disable' is called. Calling this
     * function more than once will have no ill effects.
     */
    function enable(opts) {
        if (originalLoader) {
            // Already hooked
            return;
        }

        options = getEffectiveOptions(opts);

        if (options.useCleanCache) {
            originalCache = m._cache;
            m._cache = copyNativeModules({}, originalCache);
        }

        originalLoader = m._load;
        m._load = hookedLoader;
    }

    /*
     * Disables mockery by unhooking from the Node loader. No subsequent 'require'
     * invocations will be seen by mockery. Calling this function more than once
     * will have no ill effects.
     */
    function disable() {
        if (!originalLoader) {
            // Not hooked
            return;
        }

        if (options.useCleanCache) {
            copyNativeModules(originalCache, m._cache);
            m._cache = originalCache;
            originalCache = null;
        }

        m._load = originalLoader;
        originalLoader = null;
    }

    /*
     * Copy all native modules from one cache to another.
     * @param destination
     * @param source
     */
    function copyNativeModules(destination, source) {
        for (var id in source) {
            if(has(source, id) && matchNativeModuleId.test(id)) {
                destination[id] = source[id];
            }
        }
        return destination;
    }

    /*
     * If the clean cache option is in effect, reset the module cache to an empty
     * state. Calling this function when the clean cache option is not in effect
     * will have no ill effects, but will do nothing.
     */
    function resetCache() {
        if (options.useCleanCache && originalCache) {
            m._cache = {};
        }
    }

    /*
     * Enable or disable warnings to the console when previously registered mocks
     * and subsitutes are replaced.
     */
    function warnOnReplace(enable) {
        options.warnOnReplace = enable;
    }

    /*
     * Enable or disable warnings to the console when modules are loaded that have
     * not been registered as a mock, a substitute, or allowed.
     */
    function warnOnUnregistered(enable) {
        options.warnOnUnregistered = enable;
    }

    /*
     * Register a mock object for the specified module. While mockery is enabled,
     * any subsequent 'require' for this module will return the mock object. The
     * mock need not mock out all original exports, but no fallback is provided
     * for anything not mocked and subsequently invoked.
     */
    function registerMock(mod, mock) {
        var path = m._resolveFilename(mod, parentModule);
        if (options.warnOnReplace && has(registeredMocks, path)) {
            console.warn("WARNING: Replacing existing mock for module: " + mod);
        }
        registeredMocks[path] = mock;
    }

    /*
     * Deregister a mock object for the specified module. A subsequent 'require' for
     * that module will revert to the previous behaviour (which, by default, means
     * falling back to the original 'require' behaviour).
     */
    function deregisterMock(mod) {
        var path = m._resolveFilename(mod, parentModule);
        if (has(registeredMocks, path)) {
            delete registeredMocks[path];
        }
    }

    /*
     * Register a substitute module for the specified module. While mockery is
     * enabled, any subsequent 'require' for this module will be effectively
     * replaced by a 'require' for the substitute module. This is useful when
     * a mock implementation is itself implemented as a module.
     */
    function registerSubstitute(mod, subst) {
        if(typeof subst !== "string" && subst !== null) {
            throw new Error("Substitute must be a string or null");
        }
        var path = m._resolveFilename(mod, parentModule);
        if (options.warnOnReplace && has(registeredSubstitutes, path)) {
            console.warn("WARNING: Replacing existing substitute for module: " + mod);
        }
        registeredSubstitutes[path] = {
            name: subst,
            parent: parentModule
        };
    }

    /*
     * Deregister a substitute module for the specified module. A subsequent
     * 'require' for that module will revert to the previous behaviour (which, by
     * default, means falling back to the original 'require' behaviour).
     */
    function deregisterSubstitute(mod) {
        var path = m._resolveFilename(mod, parentModule);
        if (has(registeredSubstitutes, path)) {
            delete registeredSubstitutes[path];
        }
    }

    /*
     * Register a module as 'allowed', meaning that, even if a mock or substitute
     * for it has not been registered, mockery will not complain when it is loaded
     * via 'require'. This encourages the user to consciously declare the modules
     * that will be loaded and used in the original form, thus avoiding warnings.
     *
     * If 'unhook' is true, the module will be removed from the module cache when
     * it is deregistered.
     */
    function registerAllowable(mod, unhook) {
        var path = m._resolveFilename(mod, parentModule);
        if(matchNativeModuleId.test(path) && unhook) {
            throw new Error("Cannot unhook native modules");
        }
        registeredAllowables[path] = {
            unhook: !!unhook,
            paths: []
        };
    }

    /*
     * Register an array of modules as 'allowed'. This is a convenience function
     * that performs the same function as 'registerAllowable' but for an array of
     * modules rather than a single module.
     */
    function registerAllowables(mods, unhook) {
        mods.forEach(function (mod) {
            registerAllowable(mod, unhook);
        });
    }

    /*
     * Deregister a module as 'allowed'. A subsequent 'require' for that module
     * will generate a warning that the module is not allowed, unless or until a
     * mock or substitute is registered for that module.
     */
    function deregisterAllowable(mod) {
        var path = m._resolveFilename(mod, parentModule);
        if (has(registeredAllowables, path)) {
            var allow = registeredAllowables[path];
            if (allow.unhook) {
                allow.paths.forEach(function (p) {
                    delete m._cache[p];
                });
            }
            delete registeredAllowables[path];
        }
    }
    
    /*
     * Deregister an array of modules as 'allowed'. This is a convenience function
     * that performs the same function as 'deregisterAllowable' but for an array of
     * modules rather than a single module.
     */
    function deregisterAllowables(mods) {
        mods.forEach(function (mod) {
            deregisterAllowable(mod);
        });
    }

    /*
     * Deregister all mocks, substitutes, and allowed modules, resetting the state
     * to a clean slate. This does not affect the enabled / disabled state of
     * mockery, though.
     */
    function deregisterAll() {
        Object.keys(registeredAllowables).forEach(function (mod) {
            var allow = registeredAllowables[mod];
            if (allow.unhook) {
                allow.paths.forEach(function (p) {
                    delete m._cache[p];
                });
            }
        });

        registeredMocks = blank();
        registeredSubstitutes = blank();
        registeredAllowables = blank();
    }

    // Exported functions
    var mockery = {};
    mockery.enable = enable;
    mockery.disable = disable;
    mockery.resetCache = resetCache;
    mockery.warnOnReplace = warnOnReplace;
    mockery.warnOnUnregistered = warnOnUnregistered;
    mockery.registerMock = registerMock;
    mockery.registerSubstitute = registerSubstitute;
    mockery.registerAllowable = registerAllowable;
    mockery.registerAllowables = registerAllowables;
    mockery.deregisterMock = deregisterMock;
    mockery.deregisterSubstitute = deregisterSubstitute;
    mockery.deregisterAllowable = deregisterAllowable;
    mockery.deregisterAllowables = deregisterAllowables;
    mockery.deregisterAll = deregisterAll;
    return mockery;
}

/*
 * A cache of mockery instances.
 *
 * This way, if the same module `require('mockery')` multiple times, it will get the same instance of mockery.
 */
var mockeryCache = blank();

/*
 * Return a mockery instance for the given parent module, creating it if it doesn't exist.
 */
exports.init = function(parentModule) {
    var mockery = mockeryCache[parentModule.id];
    if(mockery) return mockery;
    mockery = mockeryCache[parentModule.id] = createInstance(parentModule);
    return mockery;
}
