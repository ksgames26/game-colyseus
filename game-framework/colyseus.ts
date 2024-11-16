//@ts-ignore 
import ColyseusImpl from "../node_modules/colyseus.js/dist/colyseus-cocos-creator.js";
import { Room } from "./room.js";
type Colyseus = typeof import("colyseus.js");
const colyseus: typeof import("colyseus.js") = ColyseusImpl;

export interface S2C_Replay {
    /**
     * 响应唯一ID，与请求对应
     */
    resUniqueId: number;
    /**
     * 响应内容
     */
    resBody: Uint8Array;
    /**
     * 响应码
     */
    resCode: number;
}

export interface EventOverview {
    [key: `$${number}`]: { room: Room,  message: S2C_Replay },
    "onLeave": { room: Room, code: number, message: string | undefined },
    "onError": { room: Room, code: number, message: string | undefined },
    "onMessage": { room: Room, type: string, message: string | ArrayBuffer | S2C_Replay },
}

export { colyseus };
