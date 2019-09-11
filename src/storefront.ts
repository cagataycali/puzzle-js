import { GatewayStorefrontInstance } from "./gatewayStorefront";
import { Page } from "./page";
import { series } from "async";
import { EVENTS, HEALTHCHECK_PATHS, HTTP_METHODS, HTTP_STATUS_CODE } from "./enums";
import { LIB_CONTENT_DEBUG, wait } from "./util";
import { Logger } from "./logger";
import { callableOnce, sealed } from "./decorators";
import { container, TYPES } from "./base";
import { Server } from "./server";
import { IGatewayMap, IPageMap, IStorefrontConfig } from "./types";
import ResourceFactory from "./resourceFactory";
import { GATEWAY_PREPERATION_CHECK_INTERVAL, PUZZLE_DEBUGGER_LINK, TEMP_FOLDER } from "./config";
import { StorefrontConfigurator } from "./configurator";

import fs from "fs";

const logger = container.get(TYPES.Logger) as Logger;


@sealed
export class Storefront {
    server: Server;
    config: IStorefrontConfig;
    pages: Map<string, Page> = new Map();
    gateways: IGatewayMap = {};
    private gatewaysReady = 0;


    /**
     * Storefront Instance
     * @param {IStorefrontConfig} storefrontConfig
     * @param {Server} _server
     */
    constructor(storefrontConfig: IStorefrontConfig | StorefrontConfigurator, _server?: Server) {
        this.server = _server || container.get(TYPES.Server);

        if (storefrontConfig instanceof StorefrontConfigurator) {
            this.config = storefrontConfig.configuration;
        } else {
            this.config = storefrontConfig;
        }

        this.bootstrap();
    }

    /**
     * Starts storefront instance
     * @param {Function} cb
     */
    @callableOnce
    init(cb?: Function) {
        logger.info('Starting Puzzle Storefront');
        series([
            this.registerDependencies.bind(this),
            this.waitForGateways.bind(this),
            this.registerDebugScripts.bind(this),
            this.addCustomHeaders.bind(this),
            this.addHealthCheckRoute.bind(this),
            this.preLoadPages.bind(this),
            this.addPageRoute.bind(this)
        ], err => {
            if (!err) {
                this.server.listen(this.config.port, () => {
                    logger.info(`Storefront is listening on port ${this.config.port}`);
                    cb && cb();
                }, this.config.ipv4);
            } else {
                throw err;
            }
        });
    }

    private preLoadPages(cb: Function) {
        Promise.all(Object.values(this.pages).map(async (page) => {
            logger.info(`Preloading page: ${page.name}`);
            await page.reCompile();
            logger.info(`Preloaded page: ${page.name}`);
        })).then(() => cb());
    }

    private bootstrap() {
        if (!fs.existsSync(TEMP_FOLDER)) {
            fs.mkdirSync(TEMP_FOLDER);
        }
        this.server.useProtocolOptions(this.config.spdy);
        this.createStorefrontPagesAndGateways();
    }

    /**
     * Creates static routes for debugging scripts
     * @param {Function} cb
     * @returns {Promise<void>}
     */
    private async registerDebugScripts(cb: Function) {
        this.server.addRoute(PUZZLE_DEBUGGER_LINK, HTTP_METHODS.GET, (req, res) => {
            res.set('Content-Type', 'application/javascript');
            res.send(LIB_CONTENT_DEBUG);
        });

        cb(null);
    }

    /**
     * Waits for gateways to be prepared
     * @param {Function} cb
     * @returns {Promise<void>}
     */
    private async waitForGateways(cb: Function) {
        while (Object.keys(this.gateways).length != this.gatewaysReady) {
            await wait(GATEWAY_PREPERATION_CHECK_INTERVAL);
        }
        cb(null);
    }

    /**
     * Creates gateway pages, pages and subscribes event to gateways to track ready status
     */
    private createStorefrontPagesAndGateways() {
        this.config.gateways.forEach(gatewayConfiguration => {
            const gateway = new GatewayStorefrontInstance(gatewayConfiguration, this.config.authToken, this.config.satisfyUpdateCount);
            gateway.events.once(EVENTS.GATEWAY_READY, () => {
                this.gatewaysReady++;
            });
            gateway.startUpdating();
            this.gateways[gatewayConfiguration.name] = gateway;
        });

        this.config.pages.forEach(pageConfiguration => {
            this.pages.set(pageConfiguration.name, new Page(pageConfiguration.html, this.gateways, pageConfiguration.name));
        });
    }

    /**
     * Registers provided dependencies in storefront configuration
     * @param {Function} cb
     */
    private registerDependencies(cb: Function) {
        this.config.dependencies.forEach(dependency => {
            logger.info(`Registering Dependency: ${dependency.name}`);
            ResourceFactory.instance.registerDependencies(dependency);
        });

        cb();
    }

    /**
     * Adds healthcheck route.
     * @param {Function} cb
     */
    private addHealthCheckRoute(cb: Function) {
        logger.info(`Registering healthcheck routes: ${HEALTHCHECK_PATHS}`);
        this.server.addRoute(HEALTHCHECK_PATHS, HTTP_METHODS.GET, (req, res) => {
            res.status(HTTP_STATUS_CODE.OK).end();
        });

        cb();
    }

    /**
     * Adds custom headers
     * @param {Function} cb
     */

    private addCustomHeaders(cb: Function) {
        this.server.addCustomHeaders(this.config.customHeaders);
        cb();
    }

    /**
     * Adds page routes then connects with page instance responsible for it.
     * @param {Function} cb
     */
    private addPageRoute(cb: Function) {
        this.config.pages.forEach(pageConfiguration => {
            const page = this.pages.get(pageConfiguration.name);
            if (page) {
                logger.info(`Adding page ${pageConfiguration.name} route: ${pageConfiguration.url}`);
                this.server.addRoute(pageConfiguration.url, HTTP_METHODS.GET, (req, res, next) => {
                    logger.info(`Request route name: ${page.name} - ${req.url} - ${JSON.stringify(req.headers)}`);
                    if (typeof pageConfiguration.condition === 'function' ? pageConfiguration.condition(req) : true) {
                        page.handle(req, res);
                    } else {
                        next();
                    }
                });
                this.server.addRoute(pageConfiguration.url, HTTP_METHODS.POST, (req, res, next) => {
                    page.post(req, res, next);
                });
            }
        });

        cb();
    }
}
