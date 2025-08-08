import { assert } from "cc";
import { DEBUG } from "cc/env";
import { C2S_MESSAGE, logger, setTimeoutAsync } from "db://game-core/game-framework";
import { colyseus } from "./colyseus";
import { Room } from "./room";

export interface IPlayer {
    id: string;
}

export interface IRoomState {
    players: Map<string, IPlayer>;
}


/**
 * Colyseus SDK
 * 
 * 当前架构登录和比赛是使用了两个不同的ws链接
 * 
 * 对于多客户端链接平台兼容性有待考证。现在是登录后会主动断开链接
 *
 * @export
 * @class ColyseusSdk
 * @implements {IGameFramework.ISingleton}
 */
export class ColyseusSdk implements IGameFramework.IDisposable {
    private _hostname = "localhost";
    private _port = 2567;
    private _useSSL = false;
    private _url = "";
    private _address = "";
    private _reqUniqueId = 0;

    private _disposed = false;
    private _client!: Colyseus.Client;
    private _room: IGameFramework.Nullable<Room> = null;
    private _joinByID: boolean = false;

    public get reqUniqueId() {
        return this._reqUniqueId++;
    }

    public get isDisposed() {
        return this._disposed;
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        if (this._room) {
            this._room.dispose();
            this._room = null;
        }

        this._client = null!;
    }

    public initialize(args: ({
        hostname: string;
        port: number;
        url?: never;
    } | {
        hostname?: never;
        port?: never;
        url: string;
    }) & { useSSL?: boolean }) {

        DEBUG && assert(!!args, "args is null");

        this._useSSL = args.useSSL ?? false;

        if (args.url) {
            this._url = args.url;
            if (this._url.startsWith("ws://") || this._url.startsWith("wss://")) {
                this._address = this._url;
            } else {
                this._address = `ws${this._useSSL ? "s" : ""}://${this._url}`;
            }
        } else {
            DEBUG && assert(!!args.hostname, "args.hostname is null");
            DEBUG && assert(!!args.port, "args.port is null");
            DEBUG && assert(typeof args.port === "number", "args.port is not number");

            this._hostname = args.hostname!;
            this._port = args.port!;
            this._address = `ws${this._useSSL ? "s" : ""}://${this._hostname}:${this._port}`;
        }

        DEBUG && assert(!this._address.includes("null") && !this._address.includes("undefined"), "address is invalid");
    }

    public async joinRoom<T, R extends Room>(room: string, joinData: T, ctor?: IGameFramework.Constructor<R>): Promise<boolean> {
        this._joinByID = false;
        return await this.join(room, joinData, ctor);
    }

    public async jointRoomByID<T, R extends Room>(roomId: string, joinData: T, ctor?: IGameFramework.Constructor<R>): Promise<boolean> {
        this._joinByID = true;
        return await this.join(roomId, joinData, ctor);
    }

    public async leaveRoom(): Promise<boolean> {
        if (this._disposed) return false;

        if (this._room) {
            this._room.dispose();
            this._room = null;
        }

        return true;
    }

    public getRoom(): IGameFramework.Nullable<Room> {
        return this._room;
    }

    /**
     * 发送消息,服务器不会1对1应答，但是可能会有其他消息推送
     *
     * @template R
     * @param {string} roomName
     * @param {ArrayBuffer} data
     * @param {string} [type=C2S_MESSAGE]
     * @return {*}  {Promise<IGameFramework.Nullable<R>>}
     * @memberof ColyseusSdk
     */
    public async rpcHasPushMessage<R extends object>(data: ArrayBuffer, type: string = C2S_MESSAGE): Promise<IGameFramework.Nullable<R>> {
        if (this._disposed) return null;

        const room = this._room;
        if (!room) {
            logger.warn(`room is not exist`);
            return;
        }

        if (room.isOpen) {
            room.send(type, data);
        } else {
            logger.warn(`room ${room.name} is not connected`);
        }
    }

    /**
     * 发送消息并等待服务器回复
     *
     * @template R
     * @param {number} reqUniqueId
     * @param {ArrayBuffer} data
     * @param {number} [timeout=20_000]
     * @param {string} [type=C2S_MESSAGE]
     * @return {*}  {Promise<IGameFramework.Nullable<R>>}
     * @memberof ColyseusSdk
     */
    public async rpcHasReplyMessage<R extends object>(reqUniqueId: number, data: ArrayBuffer, timeout: number = 20_000, type: string = C2S_MESSAGE): Promise<IGameFramework.Nullable<R>> {
        if (this._disposed) return null;

        const room = this._room;
        if (!room) {
            logger.warn(`room is not exist`);
            return;
        }

        if (room.isOpen) {
            room.send(type, data);
            let timeId: NodeJS.Timeout = null!;
            let timeoutPromise = new Promise<void>((resolve) => { timeId = setTimeout(resolve, timeout); });
            const msg = await Promise.race([timeoutPromise, room.addAsyncListener(`$${reqUniqueId}`)]);

            // 不管有没有收到服务器消息，都要清除定时器
            timeId != null && clearTimeout(timeId);

            if (msg) {
                // 事件发送后会自动remove。所以这里不需要手动remove
                return msg.message as R;
            } else {
                room.removeListeners(`$${reqUniqueId}`);
            }
        } else {
            logger.warn(`room ${room.name} is not connected`);
        }
    }

    private async join<T, R extends Room>(roomNameOrID: string, joinData: T, ctor?: IGameFramework.Constructor<R>): Promise<boolean> {
        if (!this._client) {
            this._client = new colyseus.Client(this._address);
        }
        if (this._disposed) return false;

        const exist = this._room;
        if (exist) {
            if (exist.isOpen) {
                return true;
            } else {
                logger.warn("删除已经断开链接的旧房间");

                exist.dispose();
                this._room = null;
            }
        }

        const inst = await this._connect(3, roomNameOrID, joinData);
        if (inst) {
            let impl = ctor ?? Room;
            this._room = new impl(roomNameOrID, inst).listen(this);
            return true;
        } else {
            logger.warn(`连接到房间 ${roomNameOrID} 失败`);
            this._room = null;
            this._client = null!;
        }

        return false;
    }

    private async _connect<T>(count: number, roomNameOrID: string, joinData: T): Promise<IGameFramework.Nullable<Colyseus.Room>> {
        try {

            let inst: Colyseus.Room | null = null;
            if (this._joinByID) {
                inst = await this._client.joinById(roomNameOrID, joinData);
            } else {
                inst = await this._client.joinOrCreate(roomNameOrID, joinData);
            }
            return inst;
        } catch (error) {
            if (this._disposed) return null;

            count--;
            if (count < 0) {
                logger.warn(
                    `Error connecting to ${this._address}`,
                )
                logger.warn("reason:", error);
                return null;
            }

            logger.log(`reconnecting to rpc room,${this._address},count:${count}`);

            // 2秒后重连
            await setTimeoutAsync(2000);
            return await this._connect(count, roomNameOrID, joinData);
        }
    }
}