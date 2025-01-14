import {
  APITags,
  BrowserHTTPRoute,
  BrowserInstance,
  CDPChromium,
  CDPLaunchOptions,
  HTTPRoutes,
  Methods,
  NotFound,
  Request,
  SystemQueryParameters,
  contentTypes,
  dedent,
  id,
  mimeTypes,
  once,
  sleep,
} from '@browserless.io/browserless';
import { mkdir, readdir } from 'fs/promises';
import { ServerResponse } from 'http';
import { createReadStream } from 'fs';
import { deleteAsync } from 'del';
import functionHandler from '../utils/function/handler.js';
import path from 'path';

interface JSONSchema {
  code: string;
  context?: Record<string, string | number>;
}

export type BodySchema = JSONSchema | string;

export interface QuerySchema extends SystemQueryParameters {
  launch?: CDPLaunchOptions | string;
}

/**
 * Responses are determined by the returned value of the downloads
 * themselves, so there isn't a static response type for this API.
 */
export type ResponseSchema = unknown;

export default class DownloadPost extends BrowserHTTPRoute {
  accepts = [contentTypes.json, contentTypes.javascript];
  auth = true;
  browser = CDPChromium;
  concurrency = true;
  contentTypes = [contentTypes.any];
  description = dedent(`
  A JSON or JavaScript content-type API for returning files Chrome has downloaded during
  the execution of puppeteer code, which is ran inside context of the browser.
  Browserless sets up a blank page, a fresh download directory, injects your puppeteer code, and then executes it.
  You can load external libraries via the "import" syntax, and import ESM-style modules
  that are written for execution inside of the browser. Once your script is finished, any
  downloaded files from Chromium are returned back with the appropriate content-type header.`);
  method = Methods.post;
  path = HTTPRoutes.download;
  tags = [APITags.browserAPI];
  handler = async (
    req: Request,
    res: ServerResponse,
    browser: BrowserInstance,
  ): Promise<void> =>
    new Promise(async (resolve, reject) => {
      const debug = this.debug();
      const config = this.config();
      const downloadPath = path.join(
        await config.getDownloadsDir(),
        `.browserless.download.${id()}`,
      );

      debug(`Generating a download directory at "${downloadPath}"`);
      await mkdir(downloadPath);
      const handler = functionHandler(config, debug, { downloadPath });
      const response = await handler(req, browser).catch((e) => {
        debug(`Error running download code handler: "${e}"`);
        reject(e);
        return null;
      });

      if (!response) {
        return;
      }

      const { page } = response;
      debug(`Download function has returned, finding downloads...`);
      async function checkIfDownloadComplete(): Promise<string | null> {
        if (res.headersSent) {
          debug(`Request headers have been sent, terminating download watch.`);
          return null;
        }
        const [fileName] = await readdir(downloadPath);
        if (!fileName || fileName.endsWith('.crdownload')) {
          await sleep(500);
          return checkIfDownloadComplete();
        }

        debug(`All files have finished downloading`);

        return path.join(downloadPath, fileName);
      }

      const filePath = await checkIfDownloadComplete();
      debug(`Closing pages.`);
      page.close();
      page.removeAllListeners();

      const rmDownload = once(
        () =>
          filePath &&
          deleteAsync(filePath, { force: true })
            .then(() => {
              debug(
                `Successfully deleted downloads from disk at "${filePath}"`,
              );
            })
            .catch((err) => {
              debug(
                `Error cleaning up downloaded files: "${err}" at "${filePath}"`,
              );
            }),
      );

      if (res.headersSent || !filePath) {
        rmDownload();
        return;
      }
      const contentType = mimeTypes.get(path.extname(filePath));
      if (contentType) {
        res.setHeader('Content-Type', contentType);
      }

      return createReadStream(filePath)
        .on('error', (error) => {
          if (error) {
            rmDownload();
            return reject(
              new NotFound(
                `Couldn't locate or send downloads in "${downloadPath}"`,
              ),
            );
          }
        })
        .on('end', () => {
          debug(`Downloads successfully sent`);
          rmDownload();
          return resolve();
        })
        .pipe(res);
    });
}
