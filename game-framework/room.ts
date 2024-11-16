import { assert } from "cc";
import { DEBUG } from "cc/env";
import type * as Colyseus from "colyseus.js";
import { logger } from "db://game-core/game-framework";
import { EventDispatcher } from "db://game-framework/game-framework";
import { S2C_Replay } from "../../../assets/scripts/protocol/req";
import { EventOverview } from "./colyseus";

export class Room implements IGameFramework.IDisposable {
    private _disposed: boolean = false;
    public name: string = "";
    public inst!: Colyseus.Room;
    private _dispatch: EventDispatcher<EventOverview> = null!;

    public get isDisposed(): boolean { return this._disposed; }

    public dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this.inst.connection.close(4000, "close");
        this._dispatch = null!;
    }

    public constructor(name: string, inst: Colyseus.Room, dispatch: EventDispatcher<EventOverview>) {
        this.name = name;
        this.inst = inst;
        this._dispatch = dispatch;
    }

    public listen(): this {
        const room = this.inst;

        // 监听所有未知信息
        room.onMessage("*", (t, m) => {
            if (typeof t == "string") {
                
                let msg = m;
                if (t == "$s2cmsg") {
                    DEBUG && assert(m instanceof ArrayBuffer, "s2cmsg must be ArrayBuffer");

                    const s2c = S2C_Replay.fromBinary(new Uint8Array(m));

                    if (this._dispatch.has(`$${s2c.resUniqueId}`)) {
                        this._dispatch.dispatch(`$${s2c.resUniqueId}`, {
                            room: this,
                            message: s2c
                        });
                        return;
                    }

                    m = s2c;
                }

                if (this._dispatch.has("onMessage")) {
                    const message = {
                        room: this,
                        type: t,
                        message: m
                    };
                    this._dispatch.dispatch("onMessage", message);
                    return;
                }
            }

            logger.log(`${this.name} match all message: *`, t, m);
        });

        // 监听错误
        room.onError((code, msg) => {
            if (this._dispatch.has("onError")) {
                const message = {
                    room: this,
                    code: code,
                    message: msg
                };
                this._dispatch.dispatch("onError", message);
            } else {
                logger.warn(`${this.name} error:`, code, msg);
            }
        });

        // 监听离开
        room.onLeave((code) => {
            if (this._dispatch.has("onLeave")) {
                const message = {
                    room: this,
                    code: code,
                    message: undefined
                };
                this._dispatch.dispatch("onLeave", message);
            } else {
                logger.warn(`${this.name} leave:`, code);
            }
        });

        return this;
    }
}