const qb = require('@electorrent/node-qbittorrent');
const fs = require('fs-extra');
const parseTorrent = require('parse-torrent');
const prettyBytes = require('pretty-bytes');
const path = require('path');
const {
  shouldRemoveTorrent,
  removeFilename,
  isTorrent,
  extractRootDomain,
} = require('./helpers');
const { filename } = require(`${global.appRoot}/lib/helpers`);

/**
 * Qbittorrent.
 */
module.exports = class Qbittorrent {
  constructor() {
    this.construct(__dirname);
    /**
     * @type {String[]}
     * @description torrent hashes
     */
    this.currentlyDownloading = [];
  }

  get qbitsettings() {
    return {
      host: this.settings.host,
      port: this.settings.port,
      user: this.settings.username,
      pass: this.settings.password,
    };
  }

  async setup() {
    this.logDebug('Setting up qbittorrent plugin');
    this.connected = false;
    this.qb = new qb(this.qbitsettings);
    this.login();
  }

  subscriptions() {
    this.subscribe('file.add', this.actOnFileAdd);
  }

  routes() {
    this.route('get', 'list', this.getList);
    this.route('get', 'transferinfo', this.getTransferInfo);
  }

  /********* Event Functions *********/

  actOnFileAdd = (path) => {
    if (this.connected && isTorrent(path)) {
      this.addTorrent(path);
    }
  };

  /********* Route Functions *********/

  getList = (req, res) => {
    this.client.getTorrents((error, list) => {
      if (error) {
        this.logDebug(`Error from qbittorrent getList: ${error}`);
        return res.status(400).send();
      }
      return res.status(200).send(
        list.map((item) => ({
          ...item,
          trackerName: extractRootDomain(item.tracker),
        }))
      );
    });
  };

  getTransferInfo = (req, res) => {
    this.client.syncMaindata((error, info) => {
      if (error) {
        this.logDebug(`Error from qbittorrent getTransferInfo: ${error}`);
        return res.status(400).send();
      }
      return res.status(200).send(info);
    });
  };

  /********* Plugin Functions *********/

  login() {
    this.qb.login(
      function (err) {
        if (err) {
          if (err.code === 'ECONNREFUSED') {
            this.logError(
              `Could not connect with these settings: ${JSON.stringify(
                this.qbitsettings
              )}`
            );
          } else {
            this.logError(`Can't connect: ${err}`);
          }
          setTimeout(() => {
            this.login();
          }, 60000);
          this.connected = false;
          return;
        }
        this.logInfo('Connected');
        this.checkSeed();
        this.checkDownload();

        this.connected = true;
      }.bind(this)
    );
  }

  checkSeedTimer() {
    setTimeout(() => {
      this.checkSeed();
    }, 300000);
  }

  checkDownloadTimer() {
    setTimeout(() => {
      this.checkDownload();
    }, 5000);
  }

  /**
   * Connect to qbittorrent
   * @returns {qb}
   * @readonly
   */
  get client() {
    try {
      return this.qb;
    } catch (e) { }
  }

  checkDownload() {
    this.client.getTorrents((error, items) => {
      if (!items || items.lentgh === 0 || error) { return }
      const currentlyDownloading = items.filter((x) => x.amount_left > 0);
      this.currentlyDownloading.forEach((hash) => {
        const torrentIndex = items.findIndex(
          (torrent) => torrent.hash === hash
        );
        const torrent = items[torrentIndex];

        if (!torrent) {
          return delete this.currentlyDownloading[torrentIndex];
        }

        if (torrent.amount_left === 0) {
          this.logInfo(`${torrent.name} has finished downloading`);
          global.emitter.emit(
            'qbittorrent.download-complete',
            torrent,
            'add',
            Qbittorrent.name
          );
        }
      });
      this.currentlyDownloading = currentlyDownloading.map((x) => x.hash);
      this.checkDownloadTimer();
    });
  }

  checkSeed(options) {
    const self = this;
    options = options || { label: 'public' };
    this.client.getTorrents((error, items) => {
      if (error || !items) {
        return;
      }

      items.forEach((torrent) => {
        if (shouldRemoveTorrent(torrent, this.settings) > 0) {
          this.client.delete(torrent.hash, (error) => {
            if (error) {
              this.logError(`Error removing ${torrent.name}`);
              return;
            }
            sendRemoveMessage(
              shouldRemoveTorrent(torrent, this.settings),
              torrent
            );
          });
        }
      });

      this.checkSeedTimer();
    });

    function sendRemoveMessage(status, torrent) {
      let message;
      const name = torrent.name.replace('.torrent').replace('.', ' ');

      switch (status) {
        case 1:
          message = `Removed ${name} because it was on a public tracker.`;
          break;
        case 2:
          message = `Removed ${name} because it has been seeded long enough. ${self.seedInfo(
            torrent
          )}`;
          break;
        case 3:
          message = `Removed ${name} because the ratio was enough. ${self.seedInfo(
            torrent
          )}`;
          break;
        default:
          message = `Removed ${name}. ${self.seedInfo(torrent)}`;
      }

      self.logInfo(message, { color: 'red' });
    }
  }

  addTorrent(torrentPath) {
    let savepath = removeFilename(torrentPath)
    if (this.settings.saveDirReplace && this.settings.saveDirReplace.match && this.settings.saveDirReplace.replaceWith) {
      savepath = savepath.replace(new RegExp(this.settings.saveDirReplace.match), this.settings.saveDirReplace.replaceWith)
    }
    const options = { savepath };
    this.client.addTorrentFile(torrentPath, options, (error) => {
      if (error) {
        this.logError(`Error adding ${torrentPath}`, error);
        return;
      }
      this.logInfo(`Added ${filename(torrentPath)}`, { color: 'green' });
      this.moveTorrent(torrentPath);
    });
  }

  moveTorrent(torrentPath) {
    const tempPath = path.resolve(global.settingsPath, 'loadedTorrents');
    fs.ensureDirSync(tempPath);

    const newPath = `${tempPath}\\${filename(torrentPath)}`;

    return fs
      .move(torrentPath, newPath, { overwrite: true })
      .then(() => {
        this.logDebug(`Moved ${torrentPath} to ${newPath}`);
        return newPath;
      })
      .catch((e) => {
        this.logError(`Error while moving ${torrentPath} to ${newPath}, ${e}`)
      });
  }

  getTorrentInfo(torrentPath) {
    return parseTorrent(fs.readFileSync(torrentPath));
  }

  seedInfo(torrent) {
    return `[UL: ${prettyBytes(torrent.uploaded)} RATIO: ${Number(
      torrent.ratio
    ).toFixed(2)}]`;
  }
};
