import { assert } from "cc";
import { DEBUG } from "cc/env";
import type * as Colyseus from "colyseus.js";
import { C2S_MESSAGE, Container, logger } from "db://game-core/game-framework";
import { EventDispatcher, TaskService } from "db://game-framework/game-framework";
import { colyseus, EventOverview } from "./colyseus";
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
 * @extends {EventDispatcher<EventOverview>}
 * @implements {IGameFramework.ISingleton}
 */
export class ColyseusSdk extends EventDispatcher<EventOverview> implements IGameFramework.IDisposable {
    private _hostname = "localhost";
    private _port = 2567;
    private _useSSL = false;
    private _address = "";
    private _reqUniqueId = 0;

    private _disposed = false;
    private _client!: Colyseus.Client;
    private _rooms: Map<string, Room> = new Map();

    public get reqUniqueId() {
        return this._reqUniqueId++;
    }

    public get isDisposed() {
        return this._disposed;
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        for (const [_, room] of this._rooms) {
            room.dispose();
        }
        this._rooms.clear();
        this._client = null!;
    }

    public initialize(args: {
        hostname: string,
        port: number,
        useSSL: boolean
    }) {

        DEBUG && assert(!!args, "args is null");
        DEBUG && assert(!!args.hostname, "args.hostname is null");
        DEBUG && assert(!!args.port, "args.port is null");
        DEBUG && assert(typeof args.port === "number", "args.port is not number");

        this._hostname = args.hostname;
        this._port = args.port;
        this._useSSL = args.useSSL;

        this._address = `ws${this._useSSL ? "s" : ""}://${this._hostname}:${this._port}`;
    }

    public async connect<T>(room: string, joinData: T): Promise<boolean> {
        if (this._disposed) return false;

        this._client = new colyseus.Client(this._address);
        const inst = await this._connect(3, room, joinData);
        if (inst) {
            this._rooms.set(room, new Room(room, inst, this).listen());
            return true;
        }

        return false;
    }

    public request(roomName: string, data: ArrayBuffer, type: string = C2S_MESSAGE): void {
        if (this._disposed) return;

        const room = this._rooms.get(roomName);
        if (!room) {
            logger.warn(`room ${roomName} is not exist`);
            return;
        }

        if (room.isOpen) {
            room.send(type, data);
        } else {
            logger.warn(`room ${roomName} is not connected`);
        }
    }

    public async rpcResMessage<R extends object>(roomName: string, reqUniqueId: number, data: ArrayBuffer, type: string = C2S_MESSAGE): Promise<IGameFramework.Nullable<R>> {
        if (this._disposed) return null;

        const room = this._rooms.get(roomName);
        if (!room) {
            logger.warn(`room ${roomName} is not exist`);
            return;
        }

        if (room.isOpen) {
            room.send(type, data);

            const msg = await this.addAsyncListener(`$${reqUniqueId}`);
            if (msg.message.resUniqueId === reqUniqueId) {
                if (msg.message.resCode == 0) {
                    const decoder = Container.getInterface("IGameFramework.ISerializable")!;
                    const data = decoder.decoder(msg.message.resBodyId, msg.message.resBody);
                    return data as R;
                } else {
                    logger.warn(`rpc error:${msg.message.resCode}`);
                }
            }
        } else {
            logger.warn(`room ${roomName} is not connected`);
        }
    }

    private async _connect<T>(count: number, room: string, joinData: T): Promise<IGameFramework.Nullable<Colyseus.Room>> {
        try {
            const inst = await this._client.join(room, joinData);
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
            const task = Container.get(TaskService)!;
            await task.waitDealy(2000);
            return await this._connect(count, room, joinData);
        }
    }
}