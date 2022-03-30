import BasePlugin from '@uppy/core/lib/BasePlugin.js'
import SparkMD5 from "spark-md5"

const stDefaultOptions = {
    gateway: '',
    md5Endpoint: '',
    md5SliceSize: 1024 * 1024 * 2, //默认文件分片大小,2MB
    onUpload: null
}

/**
 * uppy文件上传插件，针对go-fastdfs相关接口封装。
 * 1、上传前计算文件md5,调用后台接口查询是否存在一致文件，一致直接秒传。
 * 2、tus上传后，如果需要显示内容，需要使用md5查询接口获取最终下载地址
 */
export default class SuperTrans extends BasePlugin {
    constructor(uppy, opts) {
        super(uppy, opts);
        this.id = opts.id || 'SuperTransPlugin';
        this.type = 'md5Trans';
        this.opts = Object.assign(stDefaultOptions, opts);
        /**
         *
         * @param fileIDs
         * @returns {Promise<Awaited<VoidFunction>[]>}
         */
        this.prepareUpload = (fileIDs) => {
            const promises = fileIDs.map((fileID) => {
                let file = this.uppy.getFile(fileID);
                this.uppy.emit('preprocess-progress', file, {
                    mode: 'indeterminate',
                    message: "预处理文件[" + file.name + "]...",
                })
                return this.computeMd5(file)
                    .then(this.getFileInfoByMd5)
                    .then(fileInfo => {
                        if (fileInfo && fileInfo.id) {
                            console.debug("Set File State Finish", fileID);
                            let response = {
                                id: fileInfo.id,
                                uploadURL: this.uppy.getPlugin("Tus").opts.endpoint + "/" + fileInfo.id,
                                superTrans: true
                            }
                            this.uppy.setFileState(fileID, {
                                progress: {
                                    uploadComplete: true,
                                    uploadStarted: true
                                },
                                response: response
                            });
                            this.uppy.setFileMeta(fileID, {
                                md5: fileInfo.fingerprint
                            })
                            file = this.uppy.getFile(fileID);
                            this.uppy.emit('upload-success', file, response);
                        } else {
                            this.uppy.emit('preprocess-complete', file);
                        }
                    }).catch((err) => console.error(err))
            })

            return Promise.all(promises);
        }
        /**
         * 使用文件md5值查询文件服务器是否存在相应文件
         * @param md5
         * @returns {Promise<JSON>}
         */
        this.getFileInfoByMd5 = (md5) => {
            return new Promise((resolve, reject) => {
                if (md5) {
                    fetch(this.opts.md5EndPoint + md5, {
                        method: 'GET'
                    })
                        .then(response => response.json())
                        .then(json => {
                            if (json && json.id) {
                                resolve(json);
                            } else {
                                resolve();
                            }
                        })
                        .catch(() => resolve());
                } else {
                    resolve()
                }
            });
        }
        /**
         * 计算文件md5，使用文件分片方式计算，否则大文件会严重影响性能。
         * 单个分片默认为
         * @param selectedFile
         * @returns {Promise<String>}
         */
        this.computeMd5 = (selectedFile) => {
            return new Promise((resolve, reject) => {
                let localKey = "iops-" + selectedFile.id;
                let localMd5 = window.localStorage.getItem(localKey);
                if (localMd5) {
                    return resolve(localMd5);
                }

                let blobSlice = File.prototype.slice || File.prototype.mozSlice || File.prototype.webkitSlice;
                let chunkSize = this.opts.md5SliceSize;
                let file = selectedFile.data;
                let chunks = Math.ceil(file.size / chunkSize);
                let currentChunk = 0;
                let spark = new SparkMD5.ArrayBuffer();
                let fileReader = new FileReader();
                let uppy_ = this.uppy;
                fileReader.onload = function (e) {
                    console.log("计算MD5[" + file.name + "]：" + ((currentChunk + 1) / chunks * 100).toFixed(2) + "%");
                    spark.append(e.target.result);
                    currentChunk++;
                    if (currentChunk < chunks) {
                        loadNext();
                    } else {
                        let result = spark.end(false);
                        console.debug('computed hash', file.name, result);
                        window.localStorage.setItem(localKey, result);
                        uppy_.setFileMeta(selectedFile.id, {
                            md5: result
                        })
                        resolve(result);
                    }
                };

                function loadNext() {
                    let start = currentChunk * chunkSize;
                    let end = ((start + chunkSize) >= file.size) ? file.size : start + chunkSize;
                    fileReader.readAsArrayBuffer(blobSlice.call(file, start, end));
                }

                fileReader.onerror = function (obj, ev) {
                    console.log('oops, something went wrong.', obj, ev);
                    reject('oops, something went wrong.')
                };
                loadNext();
            });
        }
        uppy.on('upload-success', (file, response) => {
            let md5 = file.meta.md5;
            if (!md5) {
                console.warn("Md5 Not Found", file);
                return;
            }
            let result = {
                id: response.uploadURL.substring(response.uploadURL.lastIndexOf("/") + 1),
                url: response.uploadURL,
                path: response.uploadURL.substring(this.opts.gateway.length),
                file: file.data,
                type: file.meta.type || file.data.type
            }
            this.opts.onUpload(result);
        });
    }

    install() {
        this.uppy.addPreProcessor(this.prepareUpload);
    }

    uninstall() {
        this.uppy.removePreProcessor(this.prepareUpload);
    }
}
