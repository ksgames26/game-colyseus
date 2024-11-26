import { assert } from "cc";
import { DEBUG } from "cc/env";
import type * as Colyseus from "colyseus.js";
import { logger, S2C_MESSAGE } from "db://game-core/game-framework";
import { EventDispatcher } from "db://game-framework/game-framework";
import { S2C_Replay } from "../../../assets/scripts/protocol/req";
import { EventOverview } from "./colyseus";

export class Room extends EventDispatcher<EventOverview> implements IGameFramework.IDisposable {
    private _disposed: boolean = false;
    private _name: string = "";
    private _inst!: Colyseus.Room;

    public get isDisposed(): boolean { return this._disposed; }

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

    public get isOpen(): boolean {
        if (!this._inst) return false;
        return this._inst.connection.isOpen;
    }

    public send(type: string, message: any): void {
        if (!this._inst) {
            logger.warn(`${this._name} can not send message, because it is closed.`);
        }
        this._inst.send(type, message);
    }

    public cast<T>(): Colyseus.Room<T> {
        return this._inst as Colyseus.Room<T>;
    }

    public listen(): this {
        const room = this._inst;
        const dispatcher = this;

        // 监听所有未知信息
        room.onMessage("*", (t, m) => {
            if (typeof t == "string") {

                // 优先解析S2C_MESSAGE
                if (t == S2C_MESSAGE) {
                    DEBUG && assert(m instanceof Uint8Array, "s2cmsg must be ArrayBuffer");

                    const s2c = S2C_Replay.fromBinary(m);

                    if (dispatcher.has(`$${s2c.resUniqueId}`)) {
                        dispatcher.dispatch(`$${s2c.resUniqueId}`, {
                            room: this,
                            message: s2c
                        });
                        return;
                    }

                    m = s2c;
                }

                // 其次解析自定义信息
                if (dispatcher.has(t)) {
                    dispatcher.dispatch(t, {
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
                    dispatcher.dispatch("onMessage", message);
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