
const nbbRequire = require('nodebb-plugin-require');

const async = require('async');
const fileType = require('file-type');
const { EventEmitter2 } = require('eventemitter2');
const _ = require('underscore');
const extend = require('extend');
const fs = require('fs-extra');
const path = require('path');

const utils = require('../../public/js/utils');
const dirty = require('./dirty');

// nbb core
const nconf = nbbRequire('nconf');
const Meta = nbbRequire('src/meta');

// augmented
const Categories = require('../augmented/categories');
const Groups = require('../augmented/groups');
const User = require('../augmented//user');
const Messaging = require('../augmented/messages');
const Topics = require('../augmented/topics');
const Posts = require('../augmented//posts');
const File = require('../augmented/file');
const db = require('../augmented/database');
const privileges = require('../augmented/privileges');

// virtually augmented, from blank {} :D
const Rooms = require('../augmented/rooms');
const Votes = require('../augmented/votes');
const Bookmarks = require('../augmented/bookmarks');


const EACH_LIMIT_BATCH_SIZE = 10;

// todo use the real one
const LOGGEDIN_UID = 1;

const logPrefix = '\n[nodebb-plugin-import]';

const BACKUP_CONFIG_FILE = path.join(__dirname, '/tmp/importer.nbb.backedConfig.json');

const defaults = {
  log: true,
  passwordGen: {
    enabled: false,
    chars: '{}.-_=+qwertyuiopasdfghjklzxcvbnmQWERTYUIOPASDFGHJKLZXCVBNM1234567890',
    len: 13,
  },
  categoriesTextColors: ['#FFFFFF'],
  categoriesBgColors: ['#AB4642', '#DC9656', '#F7CA88', '#A1B56C', '#86C1B9', '#7CAFC2', '#BA8BAF', '#A16946'],
  categoriesIcons: ['fa-comment'],
  autoConfirmEmails: true,
  userReputationMultiplier: 1,

  adminTakeOwnership: {
    enable: false,
    _username: null,
    _uid: null,
  },

  importDuplicateEmails: true,
  overrideDuplicateEmailDataWithOriginalData: true,

  nbbTmpConfig: require('./nbbTmpConfig'),
};

(function (Importer) {
  const coolDownFn = function (timeout) {
    return function (next) {
      timeout = timeout || 5000;
      Importer.log(`cooling down for ${timeout / 1000} seconds`);
      setTimeout(next, timeout);
    };
  };

  Importer._dispatcher = new EventEmitter2({
    wildcard: true,
  });

  Importer.init = function (exporter, config, callback) {
    Importer.setup(exporter, config, callback);
  };

  Importer.setup = function (exporter, config, callback) {
    Importer.exporter = exporter;

    Importer._config = extend(true, {}, defaults, config && config.importer ? config.importer : config || {});

    // todo I don't like this
    Importer._config.serverLog = !!config.log.server;
    Importer._config.clientLog = !!config.log.client;
    Importer._config.verbose = !!config.log.verbose;

    Importer.emit('importer.setup.start');

    Importer.emit('importer.setup.done');
    Importer.emit('importer.ready');
    if (_.isFunction(callback)) {
      callback();
    }
  };

  // todo: warn, sync
  // i guess it's ok for now
  Importer.isDirty = function () {
    return dirty.any();
  };

  function start(flush, callback) {
    Importer.emit('importer.start');

    dirty.cleanSync();

    const series = [];

    if (flush) {
      series.push(Importer.flushData);
    } else {
      Importer.log('Skipping data flush');
    }

    async.series(series.concat([
      Importer.backupConfig,
      Importer.setTmpConfig,
      Importer.importGroups,
      coolDownFn(5000),
      Importer.importCategories,
      Importer.allowGuestsWriteOnAllCategories,
      Importer.importUsers,
      Importer.importRooms,
      Importer.importMessages,
      Importer.importTopics,
      Importer.importPosts,
      Importer.importVotes,
      Importer.importBookmarks,
      Importer.fixCategoriesParentsAndAbilities,
      Importer.fixTopicsTeasers,
      Importer.rebanMarkReadAndFollowForUsers,
      Importer.fixTopicTimestampsAndRelockLockedTopics,
      Importer.restoreConfig,
      Importer.disallowGuestsWriteOnAllCategories,
      Importer.allowGuestsReadOnAllCategories,
      Importer.fixGroupsOwnersAndRestrictCategories,
      Importer.immediateProcessEachTypes,
      Importer.teardown,
    ]), callback);
  }

  Importer.start = function (callback) {
    const config = Importer.config();
    start(config.flush, callback);
  };

  Importer.resume = function (callback) {
    Importer.emit('importer.start');
    Importer.emit('importer.resume');

    const series = [];
    if (dirty.skip('groups')) {
      Importer.warn('Skipping importGroups Phase');
    } else {
      series.push(Importer.importGroups);
    }

    if (dirty.skip('categories')) {
      Importer.warn('Skipping importCategories Phase');
    } else {
      series.push(Importer.importCategories);
      series.push(Importer.allowGuestsWriteOnAllCategories);
    }

    if (dirty.skip('users')) {
      Importer.warn('Skipping importUsers Phase');
    } else {
      series.push(Importer.importUsers);
    }

    if (dirty.skip('rooms')) {
      Importer.warn('Skipping importRooms Phase');
    } else {
      series.push(Importer.importRooms);
    }

    if (dirty.skip('messages')) {
      Importer.warn('Skipping importMessages Phase');
    } else {
      series.push(Importer.importMessages);
    }

    if (dirty.skip('topics')) {
      Importer.warn('Skipping importTopics Phase');
    } else {
      series.push(Importer.importTopics);
    }
    if (dirty.skip('posts')) {
      Importer.warn('Skipping importPosts Phase');
    } else {
      series.push(Importer.importPosts);
    }

    if (dirty.skip('votes')) {
      Importer.warn('Skipping importVotes Phase');
    } else {
      series.push(Importer.importVotes);
    }

    if (dirty.skip('bookmarks')) {
      Importer.warn('Skipping importBookmarks Phase');
    } else {
      series.push(Importer.importBookmarks);
    }

    series.push(Importer.fixCategoriesParentsAndAbilities);
    series.push(Importer.fixTopicsTeasers);
    series.push(Importer.rebanMarkReadAndFollowForUsers);
    series.push(Importer.fixTopicTimestampsAndRelockLockedTopics);
    series.push(Importer.restoreConfig);
    series.push(Importer.disallowGuestsWriteOnAllCategories);
    series.push(Importer.allowGuestsReadOnAllCategories);
    series.push(Importer.fixGroupsOwnersAndRestrictCategories);
    series.push(Importer.immediateProcessEachTypes);
    series.push(Importer.teardown);

    async.series(series, callback);
  };

  Importer.flushData = function (next) {
    async.series([
      function (done) {
        Importer.phase('purgeCategories+Topics+Bookmarks+Posts+VotesStart');
        Importer.progress(0, 1);

        // that will delete, categories, topics, topics.bookmarks, posts and posts.votes
        Categories.count((err, total) => {
          let index = 0;
          Categories.processCidsSet(
            (err, ids, nextBatch) => {
              async.eachSeries(ids, (id, cb) => {
                Importer.progress(index++, total);
                Categories.purge(id, LOGGEDIN_UID, cb);
              }, nextBatch);
            },
            { alwaysStartAt: 0 },
            (err) => {
              if (err) {
                Importer.warn(`${Importer._phase} : ${err.message}`);
              }
              Importer.progress(1, 1);
              Importer.phase('purgeCategories+Topics+Bookmarks+Posts+VotesDone');
              done();
            },
          );
        });
      },
      function (done) {
        Importer.phase('purgeUsersStart');
        Importer.progress(0, 1);

        User.count((err, total) => {
          let index = 0;
          let count = 0;
          User.processUidsSet(
            (err, ids, nextBatch) => {
              async.eachSeries(ids, (uid, cb) => {
                Importer.progress(index++, total);
                if (parseInt(uid, 10) === 1) {
                  return cb();
                }
                User.delete(LOGGEDIN_UID, uid, () => {
                  count++;
                  cb();
                });
              }, nextBatch);
            }, {
              // since we're deleting records the range is always shifting backwards, so need to advance the batch start boundary
              alwaysStartAt: 0,
              // done if the uid=1 in the only one in the db
              doneIf(start, end, ids) {
                return ids.length === 1;
              },
            },
            (err) => {
              Importer.progress(1, 1);
              Importer.phase('purgeUsersDone');
              done(err);
            },
          );
        });
      },
      function (done) {
        Importer.phase('purgeGroupsStart');
        Importer.progress(0, 1);

        Groups.count((err, total) => {
          let index = 0; let count = 0;
          Groups.processSet(
            (err, groups, nextBatch) => {
              async.eachSeries(groups, (group, cb) => {
                Importer.progress(index++, total);
                // skip if system group
                if (group.system && !group.__imported_original_data__) {
                  return cb();
                }
                Groups.destroy(group.name, () => {
                  count++;
                  cb();
                });
              }, nextBatch);
            }, {

            },
            (err) => {
              Importer.progress(1, 1);
              Importer.phase('purgeGroupsDone');
              done(err);
            },
          );
        });
      },
      function (done) {
        Importer.phase('purgeMessagesStart');
        Importer.progress(0, 1);
        Messaging.count((err, total) => {
          let index = 0;
          Messaging.each(
            (message, next) => {
              Importer.progress(index++, total);
              Messaging.deleteMessage(message.mid, message.roomId, next);
            },
            {},
            (err) => {
              Importer.progress(1, 1);
              Importer.phase('purgeMessagesDone');
              done(err);
            },
          );
        });
      },
      function (done) {
        Importer.phase('purgeRoomsStart');
        Importer.progress(0, 1);

        Rooms.count((err, total) => {
          let index = 0;
          Rooms.each(
            (room, next) => {
              Importer.progress(index++, total);
              if (!room) { // room is undefined? nothing to do
                return next();
              }
              async.waterfall([
                function (nxt) {
                  Messaging.getUidsInRoom(room.roomId, 0, -1, nxt);
                },
                function (uids, nxt) {
                  Messaging.leaveRoom(uids, room.roomId, nxt);
                },
                function (nxt) {
                  db.delete(`chat:room:${room.roomId}`, nxt);
                },
              ], next);
            },
            {},
            (err) => {
              Importer.progress(1, 1);
              Importer.phase('purgeRoomsDone');
              done(err);
            },
          );
        });
      },
      function (done) {
        Importer.phase('resetGlobalsStart');
        Importer.progress(0, 1);

        db.setObject('global', {
          nextUid: 1,
          userCount: 1,
          nextGid: 1,
          groupCount: 1,
          nextChatRoomId: 1,
          nextMid: 1,
          nextCid: 1,
          categoryCount: 1,
          nextTid: 1,
          topicCount: 1,
          nextPid: 1,
          postCount: 1,
          nextVid: 1,
          voteCount: 1,
          nextEid: 1,
          nextBid: 1,
          bookmarkCount: 1,
        }, (err) => {
          if (err) {
            return done(err);
          }
          Importer.progress(1, 1);
          Importer.phase('resetGlobalsDone');
          done();
        });
      },
      Importer.deleteTmpImportedSetsAndObjects,
    ], (err) => {
      if (err) {
        Importer.error(err);
        next(err);
      }
      next();
    });
  };

  function replacelog(msg) {
    if (!process.stdout.isTTY) {
      return;
    }
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    process.stdout.write(msg);
  }

  Importer.phasePercentage = 0;

  Importer.progress = function (count, total, interval) {
    interval = interval || 0.0000001;
    const percentage = count / total * 100;
    if (percentage === 0 || percentage >= 100 || (percentage - Importer.phasePercentage >= interval)) {
      Importer.phasePercentage = percentage;
      replacelog(`${Importer._phase} ::: ${count}/${total}, ${percentage}%`);
      Importer.emit('importer.progress', { count, total, percentage });
    }
  };

  Importer.phase = function (phase, data) {
    Importer.phasePercentage = 0;
    Importer._phase = phase;
    Importer.success(`Phase ::: ${phase}\n`);
    Importer.emit('importer.phase', { phase, data, timestamp: +new Date() });
  };

  const writeBlob = function (filepath, blob, callback) {
    let buffer; let
      ftype = { mime: 'unknown/unkown', extension: '' };

    if (!blob) {
      return callback({ message: 'blob is falsy' });
    }

    if (blob instanceof Buffer) {
      buffer = blob;
    } else {
      try {
        buffer = new Buffer(blob, 'binary');
      } catch (err) {
        err.filepath = filepath;
        return callback(err);
      }
    }

    ftype = fileType(buffer) || ftype;
    ftype.filepath = filepath;

    fs.writeFile(filepath, buffer.toString('binary'), 'binary', (err) => {
      callback(err, ftype);
    });
  };

  const incrementEmail = function (email) {
    const parts = email.split('@');
    const parts2 = parts[0].split('+');

    const first = parts2.shift();
    const added = parts2.pop();

    let nb = 1;
    if (added) {
      const match = added.match(/__imported_duplicate_email__(\d+)/);
      if (match && match[1]) {
        nb = parseInt(match[1], 10) + 1;
      } else {
        parts2.push(added);
      }
    }
    parts2.push(`__imported_duplicate_email__${nb}`);
    parts2.unshift(first);
    parts[0] = parts2.join('+');

    return parts.join('@');
  };

  Importer.importUsers = function (next) {
    Importer._lastPercentage = 0;
    Importer.phase('usersImportStart');
    Importer.progress(0, 1);
    let count = 0;
    let imported = 0;
    let alreadyImported = 0;
    const picturesTmpPath = path.join(__dirname, '/tmp/pictures');
    const folder = '_imported_profiles';
    const picturesPublicPath = path.join(nconf.get('base_dir'), nconf.get('upload_path'), '_imported_profiles');
    const config = Importer.config();
    let oldOwnerNotFound = config.adminTakeOwnership.enable;
    const startTime = +new Date();

    dirty.writeSync('users');

    fs.ensureDirSync(picturesTmpPath);
    fs.ensureDirSync(picturesPublicPath);

    Importer.exporter.countUsers((err, total) => {
      Importer.success(`Importing ${total} users.`);

      Importer.exporter.exportUsers((err, users, usersArr, nextExportBatch) => {
        async.eachSeries(usersArr, (user, done) => {
          count++;

          // todo: hack for disqus importer with users already imported, and wanting to import just the comments as Posts
          if (user.uid) {
            Importer.progress(count, total);
            return User.setImported(user._uid, user.uid, user, done);
          }

          const { _uid } = user;
          User.getImported(_uid, (err, _user) => {
            if (_user) {
              Importer.progress(count, total);
              imported++;
              alreadyImported++;
              return done();
            }
            const u = Importer.makeValidNbbUsername(user._username || '', user._alternativeUsername || '');

            let p; let
              generatedPassword;

            if (config.passwordGen.enabled) {
              generatedPassword = Importer.genRandPwd(config.passwordGen.len, config.passwordGen.chars);
              p = generatedPassword;
            } else {
              p = user._password;
            }

            const userData = {
              username: u.username,
              email: user._email,
              password: p,
            };

            if (!userData.username) {
              Importer.warn(`[process-count-at:${count}] skipping _username:${user._username}:_uid:${user._uid}, username is invalid.`);
              Importer.progress(count, total);
              return done();
            }
            Importer.log(`[process-count-at: ${count}] saving user:_uid: ${_uid}`);

            if (oldOwnerNotFound
                  && parseInt(user._uid, 10) === parseInt(config.adminTakeOwnership._uid, 10)
                  || (user._username || '').toLowerCase() === config.adminTakeOwnership._username.toLowerCase()
            ) {
              Importer.warn(`[process-count-at:${count}] skipping user: ${user._username}:${user._uid}, it was revoked ownership by the LOGGED_IN_UID=${LOGGEDIN_UID}`);
              // cache the _uid for the next phases
              Importer.config('adminTakeOwnership', {
                enable: true,
                username: user._username,
                // just an alias in this case
                _username: user._username,
                _uid: user._uid,
              });
              // no need to make it a mod or an admin, it already is
              user._level = null;
              // set to false so we don't have to match all users
              oldOwnerNotFound = false;
              // dont create, but set the fields
              return onCreate(null, LOGGEDIN_UID);
            }
            User.create(userData, onCreate);


            function onCreate(err, uid) {
              if (err) {
              	if (err.message === '[[error:email-taken]]' && (config.overrideDuplicateEmailDataWithOriginalData || true)) {
              		User.getUidByEmail(userData.email, onCreate);
					return;
				}

              	if (err.message === '[[error:email-taken]]' && config.importDuplicateEmails) {
                  userData.email = incrementEmail(userData.email);
                  User.create(userData, onCreate);
                  return;
                }

                Importer.warn(`[process-count-at: ${count}] skipping username: "${user._username}" ${err}`);
                Importer.progress(count, total);
                done();
              } else {
                if ((`${user._level}`).toLowerCase() === 'moderator') {
                  Groups.joinAt('Global Moderators', uid, user._joindate || startTime, () => {
                    Importer.warn(`${userData.username} just became a Global Moderator`);
                    onLevel();
                  });
                } else if ((`${user._level}`).toLowerCase() === 'administrator') {
                  Groups.joinAt('administrators', uid, user._joindate || startTime, () => {
                    Importer.warn(`${userData.username} became an Administrator`);
                    onLevel();
                  });
                } else {
                  onLevel();
                }

                function onLevel() {
                  if (user._groups && user._groups.length) {
                    async.eachSeries(user._groups, (_gid, next) => {
                      Groups.getImported(_gid, (err, _group) => {
                        if (_group && _group.name) {
                          Groups.joinAt(_group._name, uid, user._joindate || startTime, (e) => {
                            if (e) {
                              Importer.warn(`Error joining group.name:${_group._name } for uid:${uid}`);
                            }
                            next();
                          });
                        } else {
                          next();
                        }
                      });
                    }, () => {
                      onGroups();
                    });
                  } else {
                    onGroups();
                  }

                  function onGroups() {
                    const fields = {
                      // preseve the signature, but Nodebb allows a max of 255 chars, so i truncate with an '...' at the end
                      signature: user._signature || '',
                      website: user._website || '',
                      location: user._location || '',
                      joindate: user._joindate || startTime,
                      reputation: (user._reputation || 0) * config.userReputationMultiplier,
                      profileviews: user._profileViews || 0,
                      fullname: user._fullname || '',
                      birthday: user._birthday || '',
                      showemail: user._showemail ? 1 : 0,
                      lastposttime: user._lastposttime || 0,
                      lastonline: user._lastonline || user._joindate,

                      'email:confirmed': config.autoConfirmEmails ? 1 : 0,

                      // this is a migration script, no one is online
                      status: 'offline',

                      // don't ban the users now, ban them later, if _imported_user:_uid._banned == 1
                      banned: 0,
					  ...(user._fields || {}),
					  __imported_original_data__: JSON.stringify(_.omit(user, ['_pictureBlob', '_password', '_hashed_password', '_tmp_autogenerated_password'])),
                    };

                    utils.deleteNullUndefined(fields);

                    let keptPicture = false;

                    if (user._pictureBlob) {
                      const filename = user._pictureFilename ? `_${uid}_${user._pictureFilename}` : `${uid}.png`;
                      const tmpPath = path.join(picturesTmpPath, filename);
                      writeBlob(tmpPath, user._pictureBlob, (err) => {
                        if (err) {
                          Importer.warn(tmpPath, err);
                          User.setUserFields(uid, fields, onUserFields);
                        } else {
                          File.saveFileToLocal(filename, folder, tmpPath, (err, ret) => {
                            if (!err) {
                              fields.uploadedpicture = ret.url;
                              fields.picture = ret.url;
                              keptPicture = true;
                            } else {
                              Importer.warn(filename, err);
                            }

                            User.setUserFields(uid, fields, onUserFields);
                          });
                        }
                      });
                    } else {
                      if (user._picture) {
                        fields.uploadedpicture = user._picture;
                        fields.picture = user._picture;
                        keptPicture = true;
                      }

                      User.setUserFields(uid, fields, onUserFields);
                    }

                    function onUserFields(err, result) {
                      if (err) {
                        return done(err);
                      }

                      user.imported = true;
                      imported++;

                      fields.uid = uid;
                      user = extend(true, {}, user, fields);
                      user.keptPicture = keptPicture;
                      user.userslug = u.userslug;
                      users[_uid] = user;
                      Importer.progress(count, total);

                      const series = [];
                      if (fields.reputation > 0) {
                        // series.push(async.apply(db.sortedSetAdd, 'users:reputation', fields.reputation, uid));
                      }
                      // async.series(series, function () {
                      User.setImported(_uid, uid, user, done);
                      // });
                    }
                  }
                }
              }
            } // end onCreate
          });
        },
        nextExportBatch);
      },
      {
        // options
      },
      (err) => {
        if (err) {
          throw err;
        }
        Importer.success(`Imported ${imported}/${total} users${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);
        const nxt = function () {
          fs.remove(picturesTmpPath, () => {
            dirty.remove('users', next);
          });
        };
        if (config.autoConfirmEmails && db.keys) {
          async.parallel([
            function (done) {
              db.keys('confirm:*', (err, keys) => {
                keys.forEach((key) => {
                  db.delete(key);
                });
                done();
              });
            },
            function (done) {
              db.keys('email:*:confirm', (err, keys) => {
                keys.forEach((key) => {
                  db.delete(key);
                });
                done();
              });
            },
          ], () => {
            Importer.progress(1, 1);
            Importer.phase('usersImportDone');
            nxt();
          });
        } else {
          Importer.progress(1, 1);
          Importer.phase('usersImportDone');
          nxt();
        }
      });
    });
  };

  Importer.importRooms = function (next) {
    Importer.phase('roomsImportStart');
    Importer.progress(0, 1);

    Importer._lastPercentage = 0;
    let count = 0;
    let imported = 0;
    let alreadyImported = 0;

    dirty.writeSync('rooms');

    Importer.exporter.countRooms((err, total) => {
      Importer.success(`Importing ${total} rooms.`);
      Importer.exporter.exportRooms(
        (err, rooms, roomsArr, nextExportBatch) => {
          async.eachSeries(roomsArr, (room, done) => {
            count++;
            const { _roomId } = room;

            Rooms.getImported(_roomId, (err, _room) => {
              if (_room) {
                Importer.progress(count, total);
                imported++;
                alreadyImported++;
                return done();
              }

              async.parallel([
                function (cb) {
                  User.getImported(room._uid, (err, fromUser) => {
                    if (err) {
                      Importer.warn(`getImportedUser:_uid:${room._uid} err: ${err.message}`);
                    }
                    cb(null, fromUser);
                  });
                },
                function (cb) {
                  async.map(room._uids, (id, cb_) => {
                    User.getImported(id, (err, toUser) => {
                      if (err) {
                        Importer.warn(`getImportedUser:_uids:${id} err: ${err.message}`);
                      }
                      cb_(null, toUser);
                    });
                  }, cb);
                },
              ], (err, results) => {
                const fromUser = results[0];
                const toUsers = results[1].filter(u => !!u);

                if (!fromUser || !toUsers.length) {
                  Importer.warn(`[process-count-at: ${count}] skipping room:_roomId: ${_roomId} _uid:${room._uid}:imported: ${!!fromUser}, _uids:${room._uids}:imported: ${!!toUsers.length}`);
                  Importer.progress(count, total);
                  done();
                } else {
                  Importer.log(`[process-count-at: ${count}] saving room:_roomId: ${_roomId} _uid:${room._uid}, _uids:${room._uids}`);

                  Messaging.newRoomWithNameAndTimestamp(fromUser.uid, toUsers.map(u => u.uid), room._roomName, room._timestamp, (err, newRoom) => {
                    if (err) {
                      Importer.warn(`[process-count-at: ${count}] skipping room:_roomId: ${_roomId} _uid:${room._uid}:imported: ${!!fromUser}, _uids:${room._uids}:imported: ${!!toUsers.length} err: ${err.message}`);
                      Importer.progress(count, total);
                      return done();
                    }
                    Importer.progress(count, total);
                    room = extend(true, {}, room, newRoom);
                    imported++;
                    Rooms.setImported(_roomId, newRoom.roomId, room, done);
                  });
                }
              });
            });
          }, nextExportBatch);
        },
        {
          // options
        },
        () => {
          Importer.progress(1, 1);
          Importer.phase('roomsImportDone');
          Importer.success(`Imported ${imported}/${total} rooms${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);
          dirty.remove('rooms', next);
        },
      );
    });
  };


  Importer.importMessages = function (next) {
    Importer.phase('messagesImportStart');
    Importer.progress(0, 1);

    Importer._lastPercentage = 0;
    let count = 0;
    let imported = 0;
    let alreadyImported = 0;

    dirty.writeSync('messages');

    Importer.exporter.countMessages((err, total) => {
      Importer.success(`Importing ${total} messages.`);
      Importer.exporter.exportMessages(
        (err, messages, messagesArr, nextExportBatch) => {
          async.eachSeries(messagesArr, (message, done) => {
            count++;
            const { _mid } = message;

            Messaging.getImported(_mid, (err, _message) => {
              if (_message) {
                Importer.progress(count, total);
                imported++;
                alreadyImported++;
                return done();
              }

              async.parallel([
                function (cb) {
                  User.getImported(message._fromuid, (err, fromUser) => {
                    if (err) {
                      Importer.warn(`getImportedUser:_fromuid:${message._fromuid} err: ${err.message}`);
                    }
                    cb(null, fromUser);
                  });
                },
                function (cb) {
                  // support for backward compatible way to import messages the old way.
                  if (!message._roomId && message._touid) {
                    User.getImported(message._touid, (err, toUser) => {
                      if (err) {
                        Importer.warn(`getImportedUser:_fromuid:${message._fromuid} err: ${err.message}`);
                      }
                      cb(null, toUser);
                    });
                  } else {
                    cb(null, null);
                  }
                },
                function (cb) {
                  if (message._roomId) {
                    Rooms.getImported(message._roomId, (err, toRoom) => {
                      if (err) {
                        Importer.warn(`getImportedRoom:_roomId:${message._roomId} err: ${err.message}`);
                      }
                      cb(null, toRoom);
                    });
                  } else {
                    cb(null, null);
                  }
                },
              ], (err, results) => {
                const fromUser = results[0];
                const toUser = results[1];
                const toRoom = results[2];

                if (!fromUser) {
                  Importer.warn(`[process-count-at: ${count}] skipping message:_mid: ${_mid} _fromuid:${message._fromuid}:imported: ${!!fromUser}, _roomId:${message._roomId}:imported: ${!!toRoom}, _touid:${message._touid}:imported: ${!!toUser}`);
                  Importer.progress(count, total);
                  return done();
                }

                if (toUser) {
                  const pairPrefix = '_imported_messages_pair:';
                  const pairID = [parseInt(fromUser.uid, 10), parseInt(toUser.uid, 10)].sort().join(':');

                  db.getObject(pairPrefix + pairID, (err, pairData) => {
                    if (err || !pairData || !pairData.roomId) {
                      Messaging.newRoomWithNameAndTimestamp(fromUser.uid, [toUser.uid], `Room:${fromUser.uid}:${toUser.uid}`, message._timestamp, (err, room) => {
                        addMessage(err, room || null, (err) => {
                          db.setObject(pairPrefix + pairID, room, (err) => {
                            done(err);
                          });
                        });
                      });
                    } else {
                      addMessage(err, { roomId: pairData.roomId }, done);
                    }
                  });
                } else {
                  addMessage(null, toRoom, done);
                }

                function addMessage(err, toRoom, callback) {
                  if (!toRoom) {
                    Importer.warn(`[process-count-at: ${count}] skipping message:_mid: ${_mid} _fromuid:${message._fromuid}:imported: ${!!fromUser}, _roomId:${message._roomId}:imported: ${!!toRoom}, _touid:${message._touid}:imported: ${!!toUser}`);
                    Importer.progress(count, total);
                    callback();
                  } else {
                    Importer.log(`[process-count-at: ${count}] saving message:_mid: ${_mid} _fromuid:${message._fromuid}, _roomId:${message._roomId}`);

                    Messaging.addMessage({uid: fromUser.uid, roomId: toRoom.roomId, content: message._content, timestamp: message._timestamp, ip: message._ip}, (err, messageReturn) => {
                      if (err || !messageReturn) {
                        Importer.warn(`[process-count-at: ${count}] skipping message:_mid: ${_mid} _fromuid:${message._fromuid}:imported: ${!!fromUser}, _roomId:${message._roomId}:imported: ${!!toRoom}, _touid:${message._touid}:imported: ${!!toUser}${err ? ` err: ${err.message}` : ` messageReturn: ${!!messageReturn}`}`);
                        Importer.progress(count, total);
                        return callback();
                      }

                      imported++;
                      const { mid } = messageReturn;
                      const { roomId } = messageReturn;

                      delete messageReturn._key;

                      async.parallel([
                        function (next) {
                          db.setObjectField(`message:${mid}`, '__imported_original_data__', JSON.stringify(message), next);
                        },
                        function (next) {
                          Messaging.getUidsInRoom(roomId, 0, -1, (err, uids) => {
                            if (err) {
                              return next(err);
                            }
                            db.sortedSetsRemove(uids.map(uid => `uid:${  uid  }:chat:rooms:unread`), roomId, next);
                          });
                        },
                      ], (err) => {
                        if (err) {
                          Importer.warn(`[process-count-at: ${count}] message creation error message:_mid: ${_mid}:mid:${mid}`, err);
                          return callback();
                        }
                        Importer.progress(count, total);
                        message = extend(true, {}, message, messageReturn);
                        Messaging.setImported(_mid, mid, message, callback);
                      });
                    });
                  }
                }
              });
            });
          }, nextExportBatch);
        },
        {
          // options
        },
        (err) => {
		  if (err) {
		  	throw err;
		  }
		  Importer.progress(1, 1);
          Importer.phase('messagesImportDone');
          Importer.success(`Imported ${imported}/${total} messages${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);
          dirty.remove('messages', next);
        },
      );
    });
  };


  Importer.importCategories = function (next) {
    Importer.phase('categoriesImportStart');
    Importer.progress(0, 1);

    Importer._lastPercentage = 0;

    let count = 0;
    let imported = 0;
    let alreadyImported = 0;
    const config = Importer.config();

    dirty.writeSync('categories');

    Importer.exporter.countCategories((err, total) => {
      Importer.success(`Importing ${total} categories.`);
      Importer.exporter.exportCategories(
        (err, categories, categoriesArr, nextExportBatch) => {
          const onEach = function (category, done) {
            count++;

            // hack for disqus importer with categories already imported
            if (category.cid) {
              Importer.progress(count, total);
              return Categories.setImported(category._cid, category.cid, category, done);
            }

            const { _cid } = category;

            Categories.getImported(_cid, (err, _category) => {
              if (_category) {
                imported++;
                alreadyImported++;
                Importer.progress(count, total);
                return done();
              }

              Importer.log(`[process-count-at:${count}] saving category:_cid: ${_cid}`);

              const categoryData = {
                name: category._name || (`Category ${count + 1}`),
                description: category._description || 'no description available',
                backgroundImage: category._backgroundImage,

                // force all categories Parent to be 0, then after the import is done, we can iterate again and fix them.
                parentCid: 0,
                // same deal with disabled
                disabled: 0,

                // you can fix the order later, nbb/admin
                order: category._order || (count + 1),

                link: category._link || 0,
              };

              if (config.categoriesIcons && config.categoriesIcons.length) {
                categoryData.icon = category._icon || config.categoriesIcons[Math.floor(Math.random() * config.categoriesIcons.length)];
              }
              if (config.categoriesBgColors && config.categoriesBgColors.length) {
                categoryData.bgColor = category._bgColor || config.categoriesBgColors[Math.floor(Math.random() * config.categoriesBgColors.length)];
              }
              if (config.categoriesTextColors && config.categoriesTextColors.length) {
                categoryData.color = category._color || config.categoriesTextColors[Math.floor(Math.random() * config.categoriesTextColors.length)];
              }

              utils.deleteNullUndefined(categoryData);

              Categories.create(categoryData, onCreate);

              function onCreate(err, categoryReturn) {
                if (err) {
                  Importer.warn(`skipping category:_cid: ${_cid} : ${err}`);
                  Importer.progress(count, total);
                  return done();
                }

                const fields = {
                  __imported_original_data__: JSON.stringify(_.omit(category, [])),
				  ...(category._fields || {}),
				};

                db.setObject(`category:${categoryReturn.cid}`, fields, onFields);

                function onFields(err) {
                  if (err) {
                    Importer.warn(err);
                  }

                  Importer.progress(count, total);

                  category.imported = true;
                  imported++;
                  category = extend(true, {}, category, categoryReturn, fields);
                  categories[_cid] = category;

                  Categories.setImported(_cid, categoryReturn.cid, category, done);
                }
              }
            });
          };
          async.eachSeries(categoriesArr, onEach, nextExportBatch);
        },
        {
          // options
        },
        (err) => {
          if (err) {
            throw err;
          }
          Importer.success(`Imported ${imported}/${total} categories${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);
          Importer.progress(1, 1);
          Importer.phase('categoriesImportDone');
          dirty.remove('categories', next);
        },
      );
    });
  };

  Importer.importGroups = function (next) {
    Importer.phase('groupsImportStart');
    Importer.progress(0, 1);

    Importer._lastPercentage = 0;

    let count = 0;
    let imported = 0;
    let alreadyImported = 0;

    dirty.writeSync('groups');

    Importer.exporter.countGroups((err, total) => {
      Importer.success(`Importing ${total} groups.`);
      Importer.exporter.exportGroups(
        (err, groups, groupsArr, nextExportBatch) => {
          const onEach = function (group, done) {
            count++;
            const { _gid } = group;

            Groups.getImported(_gid, (err, _group) => {
              if (_group) {
                imported++;
                alreadyImported++;
                Importer.progress(count, total);
                return done();
              }

              Importer.log(`[process-count-at:${count}] saving group:_gid: ${_gid}`);

              const groupData = {
                name: (group._name || (`Group ${count + 1}`)).replace(/\//g, '-'),
                description: group._description || 'no description available',
                userTitle: group._userTitle,
                disableJoinRequests: group._disableJoinRequests,
                system: group._system || 0,
                private: group._private || 0,
                hidden: group._hidden || 0,
                timestamp: group._createtime || group._timestamp,
              };

              Groups.create(groupData, onCreate);

              function onCreate(err, groupReturn) {
                if (err) {
                  Importer.warn(`skipping group:_gid: ${_gid} : ${err}`);
                  Importer.progress(count, total);
                  return done();
                }

                const fields = {
                  __imported_original_data__: JSON.stringify(_.omit(group, [])),
                  userTitleEnabled: utils.isNumber(group._userTitleEnabled) ? group._userTitleEnabled : 1,
				  ...(group._fields || {}),
				};

                utils.deleteNullUndefined(fields);

                db.setObject(`group:${groupReturn.name}`, fields, onFields);

                function onFields(err) {
                  if (err) {
                    Importer.warn(err);
                  }
                  Importer.progress(count, total);
                  group.imported = true;
                  imported++;
                  group = extend(true, {}, group, groupReturn, fields);
                  groups[_gid] = group;
                  Groups.setImported(_gid, 0, group, done);
                }
              }
            });
          };
          async.eachSeries(groupsArr, onEach, nextExportBatch);
        },
        {
          // options
        },
        (err) => {
          if (err) {
            throw err;
          }
          Importer.success(`Imported ${imported}/${total} groups${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);
          Importer.progress(1, 1);
          Importer.phase('groupsImportDone');
          dirty.remove('groups', next);
        },
      );
    });
  };

  Importer.allowGuestsReadOnAllCategories = function (done) {
    Categories.each((category, next) => {
      privileges.categories.give(['find', 'read', 'topics:read'], category.cid, 'guests', next);
    },
    { async: true, eachLimit: 10 },
    () => {
      done();
    });
  };

  Importer.allowGuestsWriteOnAllCategories = function (done) {
    Categories.each((category, next) => {
      privileges.categories.allowGroupOnCategory('guests', category.cid, next);
    },
    { async: true, eachLimit: 10 },
    () => {
      done();
    });
  };

  Importer.disallowGuestsWriteOnAllCategories = function (done) {
    Categories.each((category, next) => {
      privileges.categories.disallowGroupOnCategory('guests', category.cid, next);
    },
    { async: true, eachLimit: 10 },
    () => {
      done();
    });
  };

  Importer.importTopics = function (next) {
    Importer.phase('topicsImportStart');
    Importer.progress(0, 1);

    Importer._lastPercentage = 0;
    let count = 0;
    let imported = 0;
    let alreadyImported = 0;
    const attachmentsTmpPath = path.join(__dirname, '/tmp/attachments');
    const folder = '_imported_attachments';
    const attachmentsPublicPath = path.join(nconf.get('base_dir'), nconf.get('upload_path'), '_imported_attachments');
    const config = Importer.config();

    dirty.writeSync('topics');
    fs.ensureDirSync(attachmentsTmpPath);
    fs.ensureDirSync(attachmentsPublicPath);

    Importer.exporter.countTopics((err, total) => {
      Importer.success(`Importing ${total} topics.`);
      Importer.exporter.exportTopics(
        (err, topics, topicsArr, nextExportBatch) => {
          async.eachSeries(topicsArr, (topic, done) => {
            count++;

            // todo: hack for disqus importer with topics already imported.
            if (topic.tid && parseInt(topic.tid, 10) === 1) {
              Importer.progress(count, total);
              return Topics.setImported(topic._tid, topic.tid, topic, done);
            }

            const { _tid } = topic;

            Topics.getImported(_tid, (err, _topic) => {
              if (_topic) {
                Importer.progress(count, total);
                imported++;
                alreadyImported++;
                return done();
              }

              async.parallel([
                function (cb) {
                  Categories.getImported(topic._cid, (err, cat) => {
                    if (err) {
                      Importer.warn(`getImportedCategory: ${topic._cid} err: ${err}`);
                    }
                    cb(null, cat);
                  });
                },
                function (cb) {
                  if (topic._uid) {
                    User.getImported(topic._uid, (err, usr) => {
                      if (err) {
                        Importer.warn(`getImportedUser: ${topic._uid} err: ${err}`);
                      }
                      cb(null, usr);
                    });
                  } else if (topic._uemail) {
                    User.getUidByEmail(topic._uemail, (err, uid) => {
                      if (err || !uid) {
                        return cb(null, null);
                      }
                      User.getUserData(uid, (err, data) => {
                        if (err || !uid) {
                          return cb(null, null);
                        }
                        cb(null, data);
                      });
                    });
                  } else {
                    cb(null, null);
                  }
                },
              ], (err, results) => {
                if (err) {
                  throw err;
                }

                const category = results[0] || { cid: '0' };
                const user = results[1] || { uid: '0' };

                if (!results[0]) {
                  Importer.warn(`[process-count-at:${count}] topic:_tid:"${_tid}", has a category:_cid:"${topic._cid}" that was not imported, falling back to cid:0`);
                }

                if (!category) {
                  Importer.warn(`[process-count-at:${count}] skipping topic:_tid:"${_tid}" --> _cid: ${topic._cid}:imported:${!!category}`);
                  Importer.progress(count, total);
                  done();
                } else {
                  Importer.log(`[process-count-at:${count}] saving topic:_tid: ${_tid}`);

                  if (topic._attachmentsBlobs && topic._attachmentsBlobs.length) {
                    let attachmentsIndex = 0;

                    topic._attachments = [].concat(topic._attachments || []);
                    topic._images = [].concat(topic._images || []);

                    async.eachSeries(topic._attachmentsBlobs, (_attachmentsBlob, next) => {
                      const filename = `attachment_t_${_tid}_${attachmentsIndex++}${_attachmentsBlob.filename ? `_${_attachmentsBlob.filename}` : _attachmentsBlob.extension}`;
                      const tmpPath = path.join(attachmentsTmpPath, filename);

                      writeBlob(tmpPath, _attachmentsBlob.blob, (err, ftype) => {
                        if (err) {
                          Importer.warn(tmpPath, err);
                          next();
                        } else {
                          File.saveFileToLocal(filename, folder, tmpPath, (err, ret) => {
                            if (!err) {
                              if (/image/.test(ftype.mime)) {
                                topic._images.push(ret.url);
                              } else {
                                topic._attachments.push(ret.url);
                              }
                            } else {
                              Importer.warn(filename, err);
                            }
                            next();
                          });
                        }
                      });
                    }, onAttachmentsBlobs);
                  } else {
                    onAttachmentsBlobs();
                  }

                  function onAttachmentsBlobs() {
                    topic._content = topic._content || '';

                    topic._title = utils.slugify(topic._title) ? topic._title[0].toUpperCase() + topic._title.substr(1) : utils.truncate(topic._content, 100);

                    (topic._images || []).forEach((_image) => {
                      topic._content += generateImageTag(_image);
                    });
                    (topic._attachments || []).forEach((_attachment) => {
                      topic._content += generateAnchorTag(_attachment);
                    });

                    if (topic._tags && !Array.isArray(topic._tags)) {
                      topic._tags = (`${topic._tags}`).split(',');
                    }

                    Topics.post({
                      uid: !config.adminTakeOwnership.enable ? user.uid : parseInt(config.adminTakeOwnership._uid, 10) === parseInt(topic._uid, 10) ? LOGGEDIN_UID : user.uid,
                      title: topic._title,
                      content: topic._content,
                      timestamp: topic._timestamp,
                      ip: topic._ip,
                      handle: topic._handle || topic._guest,
                      cid: category.cid,
                      thumb: topic._thumb,
                      tags: topic._tags,
                    }, (err, returnTopic) => {
                      if (err) {
                        Importer.warn(`[process-count-at:${count}] skipping topic:_tid: ${_tid}:cid:${category.cid}:_cid:${topic._cid}:uid:${user.uid}:_uid:${topic._uid} err: ${err}`);
                        Importer.progress(count, total);
                        done();
                      } else {
                        topic.imported = true;
                        imported++;

                        const topicFields = {
                          viewcount: topic._views || topic._viewcount || topic._viewscount || 0,

                          // assume that this topic not locked for now, but will iterate back again at the end and lock it back after finishing the importPosts()
                          // locked: normalizedTopic._locked ? 1 : 0,
                          locked: 0,

                          deleted: topic._deleted ? 1 : 0,

                          // if pinned, we should set the db.sortedSetAdd('cid:' + cid + ':tids', Math.pow(2, 53), tid);
                          pinned: topic._pinned ? 1 : 0,

                          __imported_original_data__: JSON.stringify(_.omit(topic, ['_attachmentsBlobs'])),
						  ...(topic._fields || {})
						};

                        const postFields = {
                          votes: topic._votes || 0,
                          reputation: topic._reputation || 0,
                          edited: topic._edited || 0,
                        };

                        utils.deleteNullUndefined(topicFields);
                        utils.deleteNullUndefined(postFields);

                        const onPinned = function () {
                          db.setObject(`topic:${returnTopic.topicData.tid}`, topicFields, (err, result) => {
                            Importer.progress(count, total);
                            if (err) {
                              Importer.warn(err);
                            }

                            Posts.setPostFields(returnTopic.postData.pid, postFields, () => {
                              topic = extend(true, {}, topic, topicFields, returnTopic.topicData);
                              topics[_tid] = topic;
                              Topics.setImported(_tid, returnTopic.topicData.tid, topic, () => {
                                done();
                              });
                            });
                          });
                        };

                        // pinned = 1 not enough to float the topic to the top in it's category
                        if (topic._pinned) {
                          Topics.tools.forcePin(returnTopic.topicData.tid, onPinned);
                        } else {
                          db.sortedSetAdd(`cid:${category.cid}:tids`, topic._timestamp, returnTopic.topicData.tid, onPinned);
                        }
                      }
                    });
                  }
                }
              });
            });
          }, nextExportBatch);
        },
        {
          // options
        },
        (err) => {
          if (err) {
            throw err;
          }
          Importer.success(`Imported ${imported}/${total} topics${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);
          Importer.progress(1, 1);
          Importer.phase('topicsImportDone');

          async.series([
            function (nxt) {
              dirty.remove('topics', nxt);
            },
            function (nxt) {
              fs.remove(attachmentsTmpPath, nxt);
            },
          ], next);
        },
      );
    });
  };

  function generateImageTag(url) {
    const href = url.url || url.src || url;
    const filename = url.filename || href.split('/').pop();
    return `\n<img class="imported-image-tag" style="display:block" src="${href}" alt="${filename}" />`;
  }
  function generateAnchorTag(url) {
    const href = url.url || url.src || url;
    const filename = url.filename || href.split('/').pop();
    return `\n<a download="${filename}" class="imported-anchor-tag" href="${href}" target="_blank">${filename}</a>`;
  }

  Importer.importPosts = function (next) {
    Importer.phase('postsImportStart');
    Importer.progress(0, 1);

    Importer._lastPercentage = 0;
    let count = 0;
    let imported = 0;
    let alreadyImported = 0;
    const startTime = +new Date();
    const attachmentsTmpPath = path.join(__dirname, '/tmp/attachments');
    const folder = '_imported_attachments';
    const attachmentsPublicPath = path.join(nconf.get('base_dir'), nconf.get('upload_path'), '_imported_attachments');
    const config = Importer.config();

    dirty.writeSync('posts');

    fs.ensureDirSync(attachmentsTmpPath);
    fs.ensureDirSync(attachmentsPublicPath);

    // this is too slow if we run it once per post, so we fake it here and then we run it 1 per topic after all imports are done,in fixTopicsTeasers()
    const oldUpdateTeaser = Topics.updateTeaser;
    Topics.updateTeaser = function (tid, callback) {
      return callback();
    };

    Importer.exporter.countPosts((err, total) => {
      Importer.success(`Importing ${total} posts.`);
      Importer.exporter.exportPosts(
        (err, posts, postsArr, nextExportBatch) => {
          async.eachSeries(postsArr, (post, done) => {
            count++;

            const { _pid } = post;

            Posts.getImported(_pid, (err, _post) => {
              if (_post) {
                Importer.progress(count, total);
                imported++;
                alreadyImported++;
                return done();
              }

              async.parallel([
                function (cb) {
                  Topics.getImported(post._tid, (err, top) => {
                    if (err) {
                      Importer.warn(`getImportedTopic: ${post._tid} err: ${err}`);
                    }
                    cb(null, top);
                  });
                },
                function (cb) {
                  if (post._uid) {
                    User.getImported(post._uid, (err, usr) => {
                      if (err) {
                        Importer.warn(`getImportedUser: ${post._uid} err: ${err}`);
                      }
                      cb(null, usr);
                    });
                  } else if (post._uemail) {
                    User.getUidByEmail(post._uemail, (err, uid) => {
                      if (err || !uid) {
                        return cb(null, null);
                      }
                      User.getUserData(uid, (err, data) => {
                        if (err || !uid) {
                          return cb(null, null);
                        }
                        cb(null, data);
                      });
                    });
                  } else {
                    cb(null, null);
                  }
                },
                function (cb) {
                  if (!post._toPid) {
                    return cb(null, null);
                  }
                  Posts.getImported(post._toPid, (err, toPost) => {
                    if (err) {
                      Importer.warn(`getImportedPost: ${post._toPid} err: ${err}`);
                    }
                    cb(null, toPost);
                  });
                },
              ], (err, results) => {
                const topic = results[0];
                const user = results[1] || { uid: 0 };
                const toPost = results[2] || { pid: null };

                if (!topic) {
                  Importer.warn(`[process-count-at: ${count}] skipping post:_pid: ${_pid} _tid:${post._tid}:uid:${user.uid}:_uid:${post._uid} imported: ${!!topic}`);
                  done();
                } else {
                  // Importer.log('[process-count-at: ' + count + '] saving post: ' + _pid + ':tid:' + topic.tid + ':_tid:' + post._tid + ':uid:' + user.uid + ':_uid:' + post._uid);

                  if (post._attachmentsBlobs && post._attachmentsBlobs.length) {
                    let attachmentsIndex = 0;

                    post._attachments = [].concat(post._attachments || []);
                    post._images = [].concat(post._images || []);

                    async.eachSeries(post._attachmentsBlobs, (_attachmentsBlob, next) => {
                      const filename = `attachment_p_${_pid}_${attachmentsIndex++}${_attachmentsBlob.filename ? `_${_attachmentsBlob.filename}` : _attachmentsBlob.extension}`;
                      const tmpPath = path.join(attachmentsTmpPath, filename);

                      writeBlob(tmpPath, _attachmentsBlob.blob, (err, ftype) => {
                        if (err) {
                          Importer.warn(tmpPath, err);
                          next();
                        } else {
                          File.saveFileToLocal(filename, folder, tmpPath, (err, ret) => {
                            if (!err) {
                              if (/image/.test(ftype.mime)) {
                                post._images.push(ret.url);
                              } else {
                                post._attachments.push(ret.url);
                              }
                            } else {
                              Importer.warn(filename, err);
                            }
                            next();
                          });
                        }
                      });
                    }, onAttachmentsBlobs);
                  } else {
                    onAttachmentsBlobs();
                  }

                  function onAttachmentsBlobs() {
                    post._content = post._content || '';
                    if ((post._images && post._images.length) || (post._attachments && post._attachments.length)) {
                      post._content += '\n<br>\n<br>';
                    }
                    (post._images || []).forEach((_image) => {
                      post._content += generateImageTag(_image);
                    });
                    (post._attachments || []).forEach((_attachment) => {
                      post._content += generateAnchorTag(_attachment);
                    });

                    if (post._tags && !Array.isArray(post._tags)) {
                      post._tags = (`${post._tags}`).split(',');
                    }

                    Posts.create({
                      uid: !config.adminTakeOwnership.enable ? user.uid : config.adminTakeOwnership._uid === post._uid ? 1 : user.uid,
                      tid: topic.tid,
                      content: post._content,
                      timestamp: post._timestamp || startTime,
                      handle: post._handle || post._guest,
                      ip: post._ip,
                      toPid: toPost.pid,
                    }, (err, postReturn) => {
                      if (err) {
                        Importer.warn(`[process-count-at: ${count}] skipping post: ${post._pid}:tid:${topic.tid}:_tid:${post._tid}:uid:${user.uid}:_uid:${post._uid} ${err}`);
                        Importer.progress(count, total);
                        done();
                      } else {
                        imported++;

                        const fields = {
                          reputation: post._reputation || 0,
                          votes: post._votes || 0,

                          edited: post._edited || 0,
                          deleted: post._deleted || 0,

                          __imported_original_data__: JSON.stringify(_.omit(post, ['_attachmentsBlobs'])),
						  ...(post._fields || {})
						};

                        utils.deleteNullUndefined(fields);

                        post = extend(true, {}, post, fields, postReturn);
                        post.imported = true;

                        async.parallel([
                          function (next) {
                            db.setObject(`post:${postReturn.pid}`, fields, next);
                          },
                          function (next) {
                            Posts.setImported(_pid, post.pid, post, next);
                          },
                        ], (err) => {
                          Importer.progress(count, total);
                          done();
                        });
                      }
                    });
                  }
                }
              });
            });
          }, nextExportBatch);
        },
        {
          // options
        },
        (err) => {
          if (err) {
          	throw err;
		  }
		  Importer.progress(1, 1);
          Importer.phase('postsImportDone');
          Importer.success(`Imported ${imported}/${total} posts${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);

          Topics.updateTeaser = oldUpdateTeaser;

          async.series([
            function (nxt) {
              dirty.remove('posts', nxt);
            },
            function (nxt) {
              fs.remove(attachmentsTmpPath, nxt);
            },
          ], next);
        },
      );
    });
  };

  Importer.importVotes = function (next) {
    Importer.phase('votesImportStart');
    Importer.progress(0, 1);

    Importer._lastPercentage = 0;

    let count = 0;
    let imported = 0;
    let alreadyImported = 0;
    let selfVoted = 0;

    dirty.writeSync('votes');

    Importer.exporter.countVotes((err, total) => {
      Importer.success(`Importing ${total} votes.`);
      Importer.exporter.exportVotes(
        (err, votes, votesArr, nextExportBatch) => {
          const onEach = function (vote, done) {
            count++;
            const { _vid } = vote;

            Votes.getImported(_vid, (err, _vote) => {
              if (_vote) {
                imported++;
                alreadyImported++;
                Importer.progress(count, total);
                return done();
              }
              if (err) {
                Importer.warn(`skipping vote:_vid: ${_vid} : ${err}`);
                Importer.progress(count, total);
                return done();
              }

              Importer.log(`[process-count-at:${count}] saving vote:_vid: ${_vid}`);

              async.parallel([
                function (cb) {
                  if (!vote._pid) return cb();

                  Posts.getImported(vote._pid, (err, post) => {
                    if (err) {
                      Importer.warn(`getImportedPost: ${vote._pid} err: ${err}`);
                    }
                    cb(null, post);
                  });
                },
                function (cb) {
                  if (!vote._tid) return cb();

                  Topics.getImported(vote._tid, (err, topic) => {
                    if (err) {
                      Importer.warn(`getImportedTopic: ${vote._tid} err: ${err}`);
                    }
                    cb(null, topic);
                  });
                },
                function (cb) {
                  if (vote._uemail) {
                    User.getUidByEmail(vote._uemail, (err, uid) => {
                      if (err || !uid) {
                        return cb(null, null);
                      }
                      User.getUserData(uid, (err, data) => {
                        if (err || !uid) {
                          return cb(null, null);
                        }
                        cb(null, data);
                      });
                    });
                  } else {
                    User.getImported(vote._uid, (err, user) => {
                      if (err) {
                        Importer.warn(`getImportedUser: ${vote._uid} err: ${err}`);
                      }
                      cb(null, user);
                    });
                  }
                },
              ],
              (err, results) => {
                const post = results[0];
                const topic = results[1];
                const user = results[2];

                const voterUid = (user || {}).uid;
                const targetUid = (post || topic || {}).uid;
                const targetPid = (post || {}).pid || (topic || {}).mainPid;

                if (targetUid == voterUid) {
                  selfVoted++;
                  Importer.progress(count, total);
                  return done();
                }

                if ((!post && !topic) || !user) {
                  Importer.warn(`[process-count-at: ${count}] skipping vote:_vid: ${_vid
                  }${vote._tid ? `, vote:_tid:${vote._tid}:imported:${!!topic}` : ''
                  }${vote._pid ? `, vote:_pid:${vote._pid}:imported:${!!post}` : ''
                  }, user:_uid:${vote._uid}:imported:${!!user}`);

                  Importer.progress(count, total);
                  return done();
                }
                if (vote._action == -1) {
                  Posts.downvote(targetPid, voterUid, onCreate);
                } else {
                  Posts.upvote(targetPid, voterUid, onCreate);
                }

                function onCreate(err, voteReturn) {
                  if (err) {
                    Importer.warn(`skipping vote:_vid: ${_vid} : ${err}`);
                    Importer.progress(count, total);
                    return done();
                  }

                  Importer.progress(count, total);

                  vote.imported = true;
                  imported++;
                  vote = extend(true, {}, vote, voteReturn);
                  votes[_vid] = vote;
                  Votes.setImported(_vid, +new Date(), vote, done);
                }
              });
            });
          };
          async.eachSeries(votesArr, onEach, nextExportBatch);
        },
        {
          // options
        },
        (err) => {
          if (err) {
            throw err;
          }
          Importer.success(`Imported ${imported}/${total} votes${
            selfVoted ? ` (skipped ${selfVoted} votes because they were self-voted.)` : ''
          }${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);
          Importer.progress(1, 1);
          Importer.phase('votesImportDone');
          dirty.remove('votes', next);
        },
      );
    });
  };

  Importer.importBookmarks = function (next) {
    Importer.phase('bookmarksImportStart');
    Importer.progress(0, 1);

    Importer._lastPercentage = 0;

    let count = 0;
    let imported = 0;
    let alreadyImported = 0;

    dirty.writeSync('bookmarks');

    Importer.exporter.countBookmarks((err, total) => {
      Importer.success(`Importing ${total} bookmarks.`);
      Importer.exporter.exportBookmarks(
        (err, bookmarks, bookmarksArr, nextExportBatch) => {
          const onEach = function (bookmark, done) {
            count++;
            const { _bid } = bookmark;

            Bookmarks.getImported(_bid, (err, _bookmark) => {
              if (_bookmark) {
                imported++;
                alreadyImported++;
                Importer.progress(count, total);
                return done();
              }

              if (err) {
                Importer.warn(`skipping bookmark:_bid: ${_bid} : ${err}`);
                Importer.progress(count, total);
                return done();
              }

              Importer.log(`[process-count-at:${count}] saving bookmark:_bid: ${_bid}`);

              async.parallel([
                function (cb) {
                  Topics.getImported(bookmark._tid, (err, topic) => {
                    if (err) {
                      Importer.warn(`getImportedTopic: ${bookmark._tid} err: ${err}`);
                    }
                    cb(null, topic);
                  });
                },
                function (cb) {
                  User.getImported(bookmark._uid, (err, user) => {
                    if (err) {
                      Importer.warn(`getImportedUser: ${bookmark._uid} err: ${err}`);
                    }
                    cb(null, user);
                  });
                },
              ],
              (err, results) => {
                const topic = results[0];
                const user = results[1];

                if (!topic || !user) {
                  Importer.warn(`[process-count-at: ${count}] skipping bookmark:_bid: ${
                    _bid}, topic:_tid:${bookmark._tid}:imported:${!!topic}, user:_uid:${bookmark._uid}:imported:${!!user}`);
                  done();
                } else {
                  Topics.setUserBookmark(topic.tid, user.uid, bookmark._index, onCreate);

                  function onCreate(err, bookmarkReturn) {
                    if (err) {
                      Importer.warn(`skipping bookmark:_bid: ${_bid} : ${err}`);
                      Importer.progress(count, total);
                      return done();
                    }

                    Importer.progress(count, total);

                    bookmark.imported = true;
                    imported++;
                    bookmark = extend(true, {}, bookmark, bookmarkReturn);
                    bookmarks[_bid] = bookmark;

                    Bookmarks.setImported(_bid, +new Date(), bookmark, done);
                  }
                }
              });
            });
          };
          async.eachSeries(bookmarksArr, onEach, nextExportBatch);
        },
        {
          // options
        },
        (err) => {
          if (err) {
            throw err;
          }
          Importer.success(`Imported ${imported}/${total} bookmarks${alreadyImported ? ` (out of which ${alreadyImported} were already imported at an earlier time)` : ''}`);
          Importer.progress(1, 1);
          Importer.phase('bookmarksImportDone');

          dirty.remove('bookmarks', next);
        },
      );
    });
  };

  Importer.teardown = function (next) {
    Importer.phase('importerTeardownStart');
    Importer.phase('importerTeardownDone');
    Importer.phase('importerComplete');
    Importer.progress(1, 1);

    Importer.emit('importer.complete');
    next();
  };

  Importer.rebanMarkReadAndFollowForUsers = function (next) {
    let count = 0;

    Importer.phase('rebanMarkReadAndFollowForUsersStart');
    Importer.progress(0, 1);

    User.count((err, total) => {
      User.each((user, done) => {
        Importer.progress(count++, total);

        const __imported_original_data__ = utils.jsonParseSafe((user || {}).__imported_original_data__, {});

        async.parallel([
          function (nxt) {
            if (!user || !parseInt(__imported_original_data__._banned, 10)) {
              return nxt();
            }
            User.ban(user.uid, () => {
              if (err) {
                Importer.warn(err);
              } else {
                Importer.log(`[process-count-at: ${count}] banned user:${user.uid} back`);
              }
              nxt();
            });
          },
          function (nxt) {
            if (!user) {
              return nxt();
            }
            let _tids = __imported_original_data__._readTids;
            if (!_tids) {
              return nxt();
            }
            try {
              // value can come back as a double-stringed version of a JSON array
              while (typeof _tids === 'string') {
                _tids = JSON.parse(_tids);
              }
            } catch (e) {
              return nxt();
            }

            async.eachLimit(_tids || [], 10, (_tid, nxtTid) => {
              Topics.getImported(_tid, (err, topic) => {
                if (err) {
                  Importer.warn(`Error:${err}`);
                  return nxtTid();
                }
                if (!topic) {
                  Importer.warn(`Error: no topic for _tid ${_tid}`);
                  return nxtTid();
                }
                Topics.markAsRead([topic.tid], user.uid, () => {
                  nxtTid();
                });
              });
            },
            () => {
              nxt();
            });
          },
          function (nxt) {
            if (!user) {
              return nxt();
            }
            let _cids = __imported_original_data__._readCids;
            if (!_cids) {
              return nxt();
            }
            try {
              while (typeof _cids === 'string') {
                _cids = JSON.parse(_cids);
              }
            } catch (e) {
              return nxt();
            }
            async.eachLimit(_cids || [], 10, (_cid, nxtCid) => {
              Categories.getImported(_cid, (err, category) => {
                if (err) {
                  Importer.warn(`Error:${err}`);
                  return nxtTid();
                }
                if (!category) {
                  Importer.warn(`Error: no topic for _cid ${_cid}`);
                  return nxtTid();
                }

                Categories.markAsRead([category.cid], user.uid, () => {
                  nxtCid();
                });
              });
            },
            () => {
              nxt();
            });
          },

          function (nxt) {
            if (!user) {
              return nxt();
            }
            let _uids = __imported_original_data__._followingUids;
            if (!_uids) {
              return nxt();
            }
            try {
              while (typeof _uids === 'string') {
                _uids = JSON.parse(_uids);
              }
            } catch (e) {
              return nxt();
            }
            async.eachLimit(_uids || [], 10, (_uid, nxtUid) => {
              async.parallel({
                followUser(next) {
                  User.getImported(_uid, next);
                },
                isFollowing(next) {
                  User.isFollowing(user.uid, _uid, next);
                },
              }, (err, results) => {
                if (err) {
                  Importer.warn(`Error:${err}`);
                  return nxtUid();
                }
                if (results.isFollowing) {
                  return nxtUid();
                }
                if (!results.followUser) {
                  Importer.warn(`followUser:_uid:${_uid} was not imported, skipping follow from user.uid:${user.uid}`);
                  return nxtUid();
                }
                User.follow(user.uid, results.followUser.uid, (err) => {
                  if (err) {
                    Importer.warn('User.follow Error: ', err);
                    return nxtUid();
                  }
                  return nxtUid();
                });
              });
            },
            () => {
              nxt();
            });
          },
		  function (nxt) {
			  if (!user || !Importer.config().autoConfirmEmails) {
        		return nxt();
        	}
        	db.sortedSetRemove('users:notvalidated', user.uid, nxt);
		  },
          function (nxt) {
            if (!user) {
              return nxt();
            }
            let _uids = __imported_original_data__._friendsUids;
            if (!_uids) {
              return nxt();
            }
            try {
              while (typeof _uids === 'string') {
                _uids = JSON.parse(_uids);
              }
            } catch (e) {
              return nxt();
            }
            async.eachLimit(_uids || [], 10, (_uid, nxtUid) => {
              async.parallel({
                friendUser(next) {
                  User.getImported(_uid, next);
                },
                isFriends(next) {
                  User.isFriends(user.uid, _uid, next);
                },
              }, (err, results) => {
                if (err) {
                  Importer.warn(`Error:${err}`);
                  return nxtUid();
                }
                if (!results.friendUser) {
                  Importer.warn(`friendUser:_uid:${_uid} was not imported, skipping friending from user.uid:${user.uid}`);
                  return nxtUid();
                }
                if (results.isFriends) {
                  Importer.warn(`friendUser:uid:${results.friendUser.uid} is already a friend of user.uid:${+user.uid}, skipping friending from user.uid:${user.uid}`);
                  return nxtUid();
                }
                User.friend(user.uid, results.friendUser.uid, (err) => {
                  if (err) {
                    Importer.warn('User.friend Error: ', err);
                    return nxtUid();
                  }
                  return nxtUid();
                });
              });
            },
            () => {
              nxt();
            });
          },

        ], done);
      },
      { async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
      (err) => {
        if (err) throw err;
        Importer.progress(1, 1);
        Importer.phase('rebanMarkReadAndFollowForUsersDone');
        next();
      });
    });
  };

  Importer.fixTopicTimestampsAndRelockLockedTopics = function (next) {
    let count = 0;

    Importer.phase('fixTopicTimestampsAndRelockLockedTopicsStart');
    Importer.progress(0, 1);

    Topics.count((err, total) => {
      Topics.each((topic, done) => {
        Importer.progress(count++, total);
        const __imported_original_data__ = utils.jsonParseSafe((topic || {}).__imported_original_data__, {});

        async.parallel({
          locking(done) {
            if (!topic || !parseInt(__imported_original_data__._locked, 10)) {
              return done();
            }
            Topics.tools.forceLock(topic.tid, done);
          },

          timestamps(done) {
            if (!topic || !topic.tid || topic.pinned) return done();

            // todo paginate this as well
            db.getSortedSetRevRange(`tid:${topic.tid}:posts`, 0, 0, (err, pids) => {
              if (err) {
                return done(err);
              }

              if (!Array.isArray(pids) || !pids.length) {
                return done();
              }

              async.parallel({
                cid(next) {
                  db.getObjectField(`topic:${topic.tid}`, 'cid', next);
                },
                lastPostTimestamp(next) {
                  db.getObjectField(`post:${pids[0]}`, 'timestamp', next);
                },
              }, (err, results) => {
                if (err) {
                  return done(err);
                }
                db.sortedSetAdd(`cid:${results.cid}:tids`, results.lastPostTimestamp, topic.tid, done);
              });
            });
          },
        }, done);
      },
      { async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
      (err) => {
        if (err) throw err;
        Importer.progress(1, 1);
        Importer.phase('fixTopicTimestampsAndRelockLockedTopicsDone');
        next();
      });
    });
  };

  Importer.fixGroupsOwnersAndRestrictCategories = function (next) {
    let count = 0;
    Importer.phase('fixGroupsOwnersAndRestrictCategoriesStart');
    Importer.progress(0, 1);

    Groups.count((err, total) => {
      Groups.each((group, done) => {
        Importer.progress(count++, total);
        if (!group || group.system) {
          return done();
        }

        const __imported_original_data__ = utils.jsonParseSafe((group || {}).__imported_original_data__, {});

        async.series([
          function (next) {
            if (!__imported_original_data__._ownerUid) {
              Importer.warn(`group.name: ${group.name} does not have an ownerUid`);
              return next();
            }
            User.getImported(__imported_original_data__._ownerUid, (err, user) => {
              if (!user) {
                Importer.warn(`group.name: ${group.name}'s owner with _ownerUid:${__imported_original_data__._ownerUid} not imported`);
                return next();
              }
              if (err) {
                Importer.warn(`group.name: ${group.name} error while User.getImported(${__imported_original_data__._ownerUid})`, err);
                return next();
              }
              Importer.warn(`group.name: ${group.name} granting ownership to uid:${user.uid}`);
              Groups.ownership.grant(user.uid, group.name, next);
            });
          },
          function (next) {
            if (!__imported_original_data__._cids) {
              return next();
            }
            let { _cids } = __imported_original_data__;
            try {
              while (typeof _cids === 'string') {
                _cids = JSON.parse(_cids);
              }
            } catch (e) {
              return next();
            }
            if (!_cids.length) {
              return next();
            }
            async.eachLimit(_cids || [], 10,
              (_cid, nxtCid) => {
                Categories.getImported(_cid, (err, category) => {
                  if (err || !category) {
                    return next();
                  }
                  // hide this category from guest and all the other registered-users, then only give access to that group
                  async.series([
                    function (nxt) {
                      privileges.categories.disallowGroupOnCategory('guests', category.cid, nxt);
                    },
                    function (nxt) {
                      privileges.categories.disallowGroupOnCategory('registered-users', category.cid, nxt);
                    },
                    function (nxt) {
                      // Importer.warn('giving group:' + group.name + ' exclusive access to cid:' + category.cid + ', name:' + category.name);
                      privileges.categories.allowGroupOnCategory(group.name, category.cid, nxt);
                    },
                  ], () => {
                    nxtCid();
                  });
                });
              },
              () => {
                next();
              });
          },
        ], () => {
          done();
        });
      },
      { async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
      (err) => {
        if (err) throw err;
        Importer.progress(1, 1);
        Importer.phase('fixGroupsOwnersAndRestrictCategoriesDone');
        next();
      });
    });
  };

	Importer.immediateProcessEachTypes = function (callback) {
		const options = {
			$refs: {
				utils,
				nconf,
				Meta,
				Categories,
				Groups,
				User,
				Messaging,
				Topics,
				Posts,
				File,
				db,
				privileges,
				Rooms,
				Votes,
				Bookmarks
			}
		};
		Importer.phase('immediateProcessEachStart');

		async.series([
			function (done) {
			    if (!Importer.exporter.supportsEachTypeImmediateProcess('user')) {
			    	return done()
				}
				Importer.phase('immediateProcessEachUsersStart');
				Importer.progress(0, 0);
				User.count((err, total) => {
					let index = 0;
					User.each(
						(obj, next) => {
							Importer.exporter.eachTypeImmediateProcess('user', obj, options, function (err) {
								Importer.progress(index++, total);
								next(err);
							});
						},
						{ async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
						(err) => {
							Importer.progress(1, 1);
							Importer.phase('immediateProcessEachUsersDone');
							done(err);
						},
					);
				});
			},
			function (done) {
				if (!Importer.exporter.supportsEachTypeImmediateProcess('message')) {
					return done()
				}
				Importer.phase('immediateProcessEachMessagesStart');
				Importer.progress(0, 0);
				Messaging.count((err, total) => {
					let index = 0;
					Messaging.each(
						(obj, next) => {
							Importer.exporter.eachTypeImmediateProcess('message', obj, options, function (err) {
								Importer.progress(index++, total);
								next(err);
							});
						},
						{ async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
						(err) => {
							Importer.progress(1, 1);
							Importer.phase('immediateProcessEachMessagesDone');
							done(err);
						},
					);
				});
			},
			function (done) {
				if (!Importer.exporter.supportsEachTypeImmediateProcess('group')) {
					return done()
				}
				Importer.phase('immediateProcessEachGroupsStart');
				Importer.progress(0, 0);
				Groups.count((err, total) => {
					let index = 0;
					Groups.each(
						(obj, next) => {
							Importer.exporter.eachTypeImmediateProcess('group', obj, options, function (err) {
								Importer.progress(index++, total);
								next(err);
							});
						},
						{ async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
						(err) => {
							Importer.progress(1, 1);
							Importer.phase('immediateProcessEachGroupsDone');
							done(err);
						},
					);
				});
			},
			function (done) {
				if (!Importer.exporter.supportsEachTypeImmediateProcess('category')) {
					return done()
				}
				Importer.phase('immediateProcessEachCategoriesStart');
				Importer.progress(0, 0);
				Categories.count((err, total) => {
					let index = 0;
					Categories.each(
						(obj, next) => {
							Importer.exporter.eachTypeImmediateProcess('category', obj, options, function (err) {
								Importer.progress(index++, total);
								next(err);
							});
						},
						{ async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
						(err) => {
							Importer.progress(1, 1);
							Importer.phase('immediateProcessEachCategoriesDone');
							done(err);
						},
					);
				});
			},
			function (done) {
				if (!Importer.exporter.supportsEachTypeImmediateProcess('topic')) {
					return done()
				}
				Importer.phase('immediateProcessEachTopicsStart');
				Importer.progress(0, 0);
				Topics.count((err, total) => {
					let index = 0;
					Topics.each(
						(obj, next) => {
							Importer.exporter.eachTypeImmediateProcess('topic', obj, options, function (err) {
								Importer.progress(index++, total);
								next(err);
							});
						},
						{ async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
						(err) => {
							Importer.progress(1, 1);
							Importer.phase('immediateProcessEachTopicsDone');
							done(err);
						},
					);
				});
			},
			function (done) {
				if (!Importer.exporter.supportsEachTypeImmediateProcess('post')) {
					return done()
				}
				Importer.phase('immediateProcessEachPostsStart');
				Importer.progress(0, 0);
				Posts.count((err, total) => {
					let index = 0;
					Posts.each(
						(obj, next) => {
							Importer.exporter.eachTypeImmediateProcess('post', obj, options, function (err) {
								Importer.progress(index++, total);
								next(err);
							});
						},
						{ async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
						(err) => {
							Importer.progress(1, 1);
							Importer.phase('immediateProcessEachPostsDone');
							done(err);
						},
					);
				});
			},
			function (done) {
				if (!Importer.exporter.supportsEachTypeImmediateProcess('bookmark')) {
					return done()
				}
				Importer.phase('immediateProcessEachBookmarksStart');
				Importer.progress(0, 0);
				Bookmarks.count((err, total) => {
					let index = 0;
					Bookmarks.each(
						(obj, next) => {
							Importer.exporter.eachTypeImmediateProcess('bookmark', obj, options, function (err) {
								Importer.progress(index++, total);
								next(err);
							});
						},
						{ async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
						(err) => {
							Importer.progress(1, 1);
							Importer.phase('immediateProcessEachBookmarksDone');
							done(err);
						},
					);
				});
			},
			function (done) {
				if (!Importer.exporter.supportsEachTypeImmediateProcess('vote')) {
					return done()
				}
				Importer.phase('immediateProcessEachVotesStart');
				Importer.progress(0, 0);
				Votes.count((err, total) => {
					let index = 0;
					Votes.each(
						(obj, next) => {
							Importer.exporter.eachTypeImmediateProcess('vote', obj, options, function (err) {
								Importer.progress(index++, total);
								next(err);
							});
						},
						{ async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
						(err) => {
							Importer.progress(1, 1);
							Importer.phase('immediateProcessEachVotesDone');
							done(err);
						},
					);
				});
			},
		], (err) => {
			if (err) throw err;
			Importer.phase('immediateProcessEachDone');
			callback(null);
		});
	};


  Importer.fixTopicsTeasers = function (next) {
    let count = 0;
    Importer.phase('fixTopicsTeasersStart');
    Importer.progress(0, 1);

    Topics.count((err, total) => {
      Topics.each((topic, done) => {
        Importer.progress(count++, total);
        Topics.updateTeaser(topic.tid, done);
      },
      { async: true, eachLimit: EACH_LIMIT_BATCH_SIZE },
      (err) => {
        if (err) throw err;
        Importer.progress(1, 1);
        Importer.phase('fixTopicsTeasersDone');
        next();
      });
    });
  };


  Importer.fixCategoriesParentsAndAbilities = function (next) {
    let count = 0;

    Importer.phase('fixCategoriesParentsAndAbilitiesStart');
    Importer.progress(0, 1);

    Categories.count((err, total) => {
      Categories.each((category, done) => {
        Importer.progress(count++, total);

        let disabled = 0;

        if (category) {
          const __imported_original_data__ = utils.jsonParseSafe((category || {}).__imported_original_data__, {});

          const cb = function (parentCid, disabled) {
            const hash = {};
            if (disabled) {
              hash.disabled = 1;
            }
            if (parentCid) {
              hash.parentCid = parentCid;
            }
            if (Object.keys(hash).length) {
              async.parallel([
                function (nxt) {
                  db.setObject(`category:${category.cid}`, hash, nxt);
                },
                function (nxt) {
                  if (parentCid) {
                    return db.sortedSetAdd(`cid:${parentCid}:children`, category.order || category.cid, category.cid, nxt);
                  }
                  nxt();
                },
                function (nxt) {
                  if (parentCid) {
                    return db.sortedSetRemove('cid:0:children', category.cid, nxt);
                  }
                  nxt();
                },
              ], done);
            } else {
              done();
            }
          };

          if (parseInt(__imported_original_data__._disabled, 10)) {
            disabled = 1;
          }
          if (__imported_original_data__._parentCid) {
            Categories.getImported(__imported_original_data__._parentCid, (err, parentCategory) => {
              cb(parentCategory && parentCategory.cid, disabled);
            });
          } else {
            cb(null, disabled);
          }
        } else {
          done();
        }
      },
      { async: true, eachLimit: 10 },
      (err) => {
        if (err) throw err;
        Importer.progress(1, 1);
        Importer.phase('fixCategoriesParentsAndAbilitiesDone');
        next();
      });
    });
  };

  Importer.backupConfig = function (next) {
    // if the backedConfig file exists, that means we did not complete the restore config last time,
    // so don't overwrite it, assuming the nodebb config in the db are the tmp ones
    if (fs.pathExistsSync(BACKUP_CONFIG_FILE)) {
      Importer.config('backedConfig', fs.readJsonSync(BACKUP_CONFIG_FILE) || {});
      next();
    } else {
      db.getObject('config', (err, data) => {
        if (err) {
          throw err;
        }
        // till https://github.com/NodeBB/NodeBB/pull/6352
        data.maximumChatMessageLength = 1000;

        Importer.config('backedConfig', data || {});
        fs.outputJsonSync(BACKUP_CONFIG_FILE, Importer.config('backedConfig'));
        next();
      });
    }
  };

  Importer.setTmpConfig = function (next) {
    // get the nbb backedConfigs, change them, then set them back to the db
    // just to make the transition a little less flexible
    // yea.. i dont know .. i have a bad feeling about this
    const config = extend(true, {}, Importer.config().backedConfig, Importer.config().nbbTmpConfig);

    if (Importer.config().autoConfirmEmails) {
      config.requireEmailConfirmation = 0;
    }

    db.setObject('config', config, (err) => {
      if (err) {
        throw err;
      }
      Meta.configs.init(next);
    });
  };

  // im nice
  Importer.restoreConfig = function (next) {
    if (fs.pathExistsSync(BACKUP_CONFIG_FILE)) {
      Importer.config('backedConfig', fs.readJsonSync(BACKUP_CONFIG_FILE));

      const { backedConfig } = Importer.config();
      backedConfig.maintenanceMode = 0;

      db.setObject('config', backedConfig, (err) => {
        if (err) {
          Importer.warn('Something went wrong while restoring your nbb configs');
          Importer.warn('here are your backed-up configs, you do it manually');
          Importer.warn(JSON.stringify(Importer.config().backedConfig));
          return next();
        }

        Importer.success(`Config restored:${JSON.stringify(Importer.config().backedConfig)}`);
        fs.removeSync(BACKUP_CONFIG_FILE);

        Meta.configs.init((err) => {
          if (err) {
            Importer.warn('Could not re-init Meta configs, just restart NodeBB, you\'ll be fine');
          }

          next();
        });
      });
    } else {
      Importer.warn(`Could not restore NodeBB tmp configs, because ${BACKUP_CONFIG_FILE} does not exist`);
      next();
    }
  };

  // which of the values is falsy
  Importer.whichIsFalsy = function (arr) {
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i]) return i;
    }
    return null;
  };

  // a helper method to generate temporary passwords
  Importer.genRandPwd = function (len, chars) {
    const index = (Math.random() * (chars.length - 1)).toFixed(0);
    return len > 0 ? chars[index] + Importer.genRandPwd(len - 1, chars) : '';
  };

  // todo: i think I got that right?
  Importer.cleanUsername = function (str) {
    str = str.replace(/[^\u00BF-\u1FFF\u2C00-\uD7FF\-.*\w\s]/gi, '');
    // todo: i don't know what I'm doing HALP
    return str.replace(/ /g, '').replace(/\*/g, '').replace(/æ/g, '').replace(/ø/g, '')
      .replace(/å/g, '');
  };

  // todo: holy fuck clean this shit
  Importer.makeValidNbbUsername = function (_username, _alternativeUsername) {
    const _userslug = utils.slugify(_username || '');

    if (utils.isUserNameValid(_username) && _userslug) {
      return { username: _username, userslug: _userslug };
    }
    const username = Importer.cleanUsername(_username);
    const userslug = utils.slugify(username);

    if (utils.isUserNameValid(username) && userslug) {
      return { username, userslug };
    } if (_alternativeUsername) {
      const _alternativeUsernameSlug = utils.slugify(_alternativeUsername);

      if (utils.isUserNameValid(_alternativeUsername) && _alternativeUsernameSlug) {
        return { username: _alternativeUsername, userslug: _alternativeUsernameSlug };
      }

      const alternativeUsername = Importer.cleanUsername(_alternativeUsername);
      const alternativeUsernameSlug = utils.slugify(alternativeUsername);

      if (utils.isUserNameValid(alternativeUsername) && alternativeUsernameSlug) {
        return { username: alternativeUsername, userslug: alternativeUsernameSlug };
      }
      return { username: null, userslug: null };
    }
    return { username: null, userslug: null };
  };

  Importer.emit = function () {
    const args = Array.prototype.slice.call(arguments, 0);

    if (args && args[args.length - 1] !== 'logged') {
      Importer.log.apply(Importer, args);
    } else {
      args.pop();
    }

    args.unshift(args[0]);
    Importer._dispatcher.emit.apply(Importer._dispatcher, args);
  };

  Importer.on = function () {
    Importer._dispatcher.on.apply(Importer._dispatcher, arguments);
  };

  Importer.once = function () {
    Importer._dispatcher.once.apply(Importer._dispatcher, arguments);
  };

  Importer.removeAllListeners = function () {
    Importer._dispatcher.removeAllListeners();
  };

  Importer.warn = function () {
    const args = _.toArray(arguments);
    args[0] = `[${(new Date()).toISOString()}] ${args[0]}`;

    args.unshift('importer.warn');
    args.push('logged');
    Importer.emit.apply(Importer, args);
    args.unshift(logPrefix);
    args.pop();

    console.warn.apply(console, args);
  };

  Importer.log = function () {
    if (!Importer.config.verbose) {
      return;
    }

    const args = _.toArray(arguments);
    args[0] = `[${(new Date()).toISOString()}] ${args[0]}`;

    args.unshift('importer.log');
    args.push('logged');

    if (Importer.config.clientLog) {
      Importer.emit.apply(Importer, args);
    }
    args.unshift(logPrefix);
    args.pop();
    if (Importer.config.serverLog) {
      console.log.apply(console, args);
    }
  };

  Importer.success = function () {
    const args = _.toArray(arguments);
    args[0] = `[${(new Date()).toISOString()}] ${args[0]}`;
    args.unshift('importer.success');
    args.push('logged');
    Importer.emit.apply(Importer, args);
    args.unshift(logPrefix);
    args.pop();

    console.log.apply(console, args);
  };

  Importer.error = function () {
    const args = _.toArray(arguments);
    args[0] = `[${(new Date()).toISOString()}] ${args[0]}`;
    args.unshift('importer.error');
    args.push('logged');
    Importer.emit.apply(Importer, args);
    args.unshift(logPrefix);
    args.pop();

    console.error.apply(console, args);
  };

  Importer.config = function (config, val) {
    if (config != null) {
      if (typeof config === 'object') {
        console.trace('Importer.config setting config', config);

        Importer._config = config;
      } else if (typeof config === 'string') {
        if (val != null) {
          Importer._config = Importer._config || {};
          Importer._config[config] = val;
        }
        return Importer._config[config];
      }
    }
    return Importer._config;
  };

  Importer.deleteTmpImportedSetsAndObjects = function (done) {
    const phasePrefix = 'deleteTmpImportedSetsAndObjects';

    async.series([
      { augmented: User, name: 'Users' },
      { augmented: Groups, name: 'Groups' },
      { augmented: Categories, name: 'Categories' },
      { augmented: Topics, name: 'Topics' },
      { augmented: Posts, name: 'Posts' },
      { augmented: Messaging, name: 'Messages' },
      { augmented: Votes, name: 'Votes' },
      { augmented: Bookmarks, name: 'Bookmarks' },
    ]
      .reduce((series, current) => {
        const Obj = current.augmented;
        const { name } = current;

        series.push((next) => {
          Importer.phase(`${phasePrefix + name}Start`);
          Obj.deleteEachImported(
            (err, progress) => {
              Importer.progress(progress.count, progress.total);
            },
            (err) => {
              Importer.progress(1, 1);
              Importer.phase(`${phasePrefix + name}Done`);
              next(err);
            },
          );
        });
        return series;
      }, []), done);
  };
}(module.exports));
