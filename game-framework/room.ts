import { assert } from "cc";
import { DEBUG } from "cc/env";
import type * as Colyseus from "colyseus.js";
import { Container, logger, S2C_MESSAGE } from "db://game-core/game-framework";
import { EventDispatcher } from "db://game-framework/game-framework";
import { S2C_Replay } from "../../../assets/scripts/protocol/req";
import { EventOverview } from "./colyseus";
import { ColyseusSdk } from "./client";

export class Room extends EventDispatcher<EventOverview> implements IGameFramework.IDisposable {
    protected _inst!: Colyseus.Room;
    private _disposed: boolean = false;
    private _name: string = "";
    private _sdk!: ColyseusSdk;

    public get isDisposed(): boolean { return this._disposed; }

    public get reqUniqueId() {
        return this._sdk.reqUniqueId;
    }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._inst.connection.close(4000, "close");
    }

    public constructor(name: string, inst: Colyseus.Room) {
        super();

        this._name = name;
        this._inst = inst;
    }

    public onInit(): void {
       
    }

    public get isOpen(): boolean {
        if (!this._inst) return false;
        return this._inst.connection.isOpen;
    }

    public send(type: string, message: any): void {
        if (!this._inst) {
            logger.warn(`${this._name} can not send message, because it is closed.`);
        }

        if (message instanceof Uint8Array || message instanceof ArrayBuffer) {
            this._inst.sendBytes(type, message);
        } else {
            this._inst.send(type, message);
        }
    }

    public cast<T>(): Colyseus.Room<T> {
        return this._inst as Colyseus.Room<T>;
    }

    public listen(sdk: ColyseusSdk): this {
        this.onInit();

        this._sdk = sdk;

        const room = this._inst;
        const dispatcher = this;

        // 监听所有未知信息
        room.onMessage("*", (t, m) => {
            if (typeof t == "string" || m instanceof Uint8Array) {
                // 优先解析S2C_MESSAGE
                if (t == S2C_MESSAGE || m instanceof Uint8Array) {
                    DEBUG && assert(m instanceof Uint8Array, "s2cmsg must be ArrayBuffer");

                    let s2c: S2C_Replay;
                    try {
                        s2c = S2C_Replay.fromBinary(m);
                    } catch (error) {
                        logger.error(`${this._name} can not parse S2C_MESSAGE, because it is invalid.`, m);
                        return;
                    }

                    let unpack: unknown = null;
                    if (s2c.resCode == 0) {
                        const decoder = Container.getInterface("IGameFramework.ISerializable")!;
                        DEBUG && assert(!!decoder, "IGameFramework.ISerializable not found.");

                        unpack = decoder.decoder(s2c.resBodyId, s2c.resBody);

                    }

                    if (dispatcher.has(`$${s2c.resUniqueId}`)) {
                        dispatcher.dispatch(`$${s2c.resUniqueId}`, {
                            room: this,
                            reply: s2c,
                            message: unpack
                        });
                        return;
                    }

                    // 直接调用房间实现上的函数
                    const fn = dispatcher[s2c.resBodyId as keyof this] as (message: S2C_Replay, data: unknown) => void;
                    if (fn) {
                        fn.call(dispatcher, s2c, unpack);
                        return;
                    }

                    m = s2c;
                }

                // 直接调用房间实现上的函数
                const fn = dispatcher[t as keyof this] as (message: unknown) => void;
                if (fn) {
                    fn.call(dispatcher, m);
                    return;
                }

                // 其次解析自定义信息
                if (dispatcher.has(t as string)) {
                    dispatcher.dispatch(t as string, {
                        room: this,
                        message: m
                    });
                    return;
                }

                // 最后解析未知信息
                if (dispatcher.has("onMessage")) {
                    const message = {
                        room: this,
                        type: t,
                        message: m
                    };
                    dispatcher.dispatch("onMessage", message as any);
                    return;
                }
            }

            // 如果上面3个解析都不匹配，只能打印一个日志看看到底是什么信息
            // 这个信息是no handled message
            logger.log(`${this._name} match all message: *`, t, m);
        });

        // 监听错误
        room.onError((code, msg) => {
            if (dispatcher.has("onError")) {
                const message = {
                    room: this,
                    code: code,
                    message: msg
                };
                dispatcher.dispatch("onError", message);
            } else {
                logger.warn(`${this._name} error:`, code, msg);
            }
        });

        // 监听离开
        room.onLeave((code) => {
            if (dispatcher.has("onLeave")) {
                const message = {
                    room: this,
                    code: code,
                    message: undefined
                };
                dispatcher.dispatch("onLeave", message);
            } else {
                logger.warn(`${this._name} leave:`, code);
            }
        });

        return this;
    }
}