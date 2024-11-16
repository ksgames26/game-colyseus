import { assert } from "cc";
import { DEBUG } from "cc/env";
import type * as Colyseus from "colyseus.js";
import { Container, logger, makeDefered } from "db://game-core/game-framework";
import { EventDispatcher, TaskService } from "db://game-framework/game-framework";
import { MessageType } from "db://game-protobuf/game-framework";
import { colyseus, EventOverview, S2C_Replay } from "./colyseus";
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

    public request(roomName: string, data: ArrayBuffer, type: string = ""): void {
        if (this._disposed) return;

        const room = this._rooms.get(roomName);
        if (!room) {
            logger.warn(`room ${roomName} is not exist`);
            return;
        }

        if (room.inst.connection.isOpen) {
            room.inst.send(type, data);
        }
    }

    public async rpcResMessage<R extends object>(roomName: string, reqUniqueId: number, data: ArrayBuffer, r: MessageType<R>, type: string = ""): Promise<IGameFramework.Nullable<R>> {
        if (this._disposed) return null;

        const room = this._rooms.get(roomName);
        if (!room) {
            logger.warn(`room ${roomName} is not exist`);
            return;
        }

        if (room.inst.connection.isOpen) {
            let { resolve, promise } = makeDefered<R>();

            this.addListener(`$${reqUniqueId}`, (msg: {
                room: Room,
                message: S2C_Replay
            }) => {
                if (msg.message.resUniqueId === reqUniqueId) {
                    if (msg.message.resCode == 0) {
                        const reply = r.fromBinary(new Uint8Array(msg.message.resBody));
                        resolve(reply);
                    } else {
                        logger.warn(`rpc error:${msg.message.resCode}`);
                        resolve(null!);
                    }
                }
            }, this, 1);
            room.inst.send(type, data);
            return await promise;
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

    // public async login(openId: string): Promise<IGameFramework.Nullable<S2C_Replay>> {
    //     this._loginClient = new colyseus.Client(`ws${this._useSSL ? "s" : ""}://${this._hostname}:${this._port}`);

    //     try {
    //         this._reqUniqueId++;

    //         const req = C2S_Request.create({
    //             reqUniqueId: this._reqUniqueId,
    //             reqBody: C2S_ReqLogin.toBinary({
    //                 openId
    //             })
    //         });

    //         const room = this._loginRoom = await this._loginClient.joinOrCreate("login", req);

    //         let _resolve: (reply: IGameFramework.Nullable<S2C_Replay>) => void;
    //         let _promise = new Promise<IGameFramework.Nullable<S2C_Replay>>(resolve => _resolve = resolve);

    //         room.onMessage("*", (t, m) => {
    //             logger.log("login onMessage: *", t, m);
    //         });

    //         room.onError((code, message) => {
    //             logger.warn("login error:", code, message);
    //         });

    //         room.onMessage("reqReply", (buffer) => {
    //             const reply = S2C_Replay.fromBinary(new Uint8Array(buffer));

    //             _resolve(reply);

    //             // 退出房间后关闭连接
    //             this._loginRoom.connection.close();
    //         });

    //         return await _promise;
    //     } catch (e: any) {
    //         logger.warn("login error: ", e.toString());
    //         return;
    //     }
    // }

    // public async joinOrCreateRoom(roomName: string, options: { mode: string, level: number }): Promise<void> {
    //     this._pkRoom = await this._pkClient.joinOrCreate(roomName, options);
    //     console.log("joinOrCreateRoom: ", this._pkRoom.roomId);
    //     this.initialize();
    // }

    // private initialize(): void {
    //     this._pkRoom.onStateChange((state) => {
    //         console.log("onStateChange before ");

    //         state.players.forEach((player) => {
    //             console.log("player: ", player.id);
    //         });

    //         console.log("onStateChange after ");
    //     });

    //     this._pkRoom.onLeave((code) => {
    //         console.log("onLeave:", code);
    //     });

    //     this._pkRoom.onMessage("*", (c) => {
    //         console.log("onMessage: *", c);
    //     });

    //     this._pkRoom.onMessage("joinSuccess", (id) => {
    //         console.log("joinSuccess", id);
    //     });
    // }
}