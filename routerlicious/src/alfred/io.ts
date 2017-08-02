import * as _ from "lodash";
import * as moniker from "moniker";
import * as nconf from "nconf";
import * as redis from "redis";
import * as request from "request";
import * as socketIo from "socket.io";
import * as socketIoRedis from "socket.io-redis";
import * as api from "../api";
import * as core from "../core";
import * as socketStorage from "../socket-storage";
import * as utils from "../utils";
import { logger } from "../utils";

let io = socketIo();

// Group this into some kind of an interface
const kafkaEndpoint = nconf.get("kafka:lib:endpoint");
const kafkaLibrary = nconf.get("kafka:lib:name");
const kafkaClientId = nconf.get("alfred:kafkaClientId");
const topic = nconf.get("alfred:topic");

const historian = nconf.get("git:historian");
const historianBranch = nconf.get("git:repository");

// Setup redis
let host = nconf.get("redis:host");
let port = nconf.get("redis:port");
let pass = nconf.get("redis:pass");

let options: any = { auth_pass: pass };
if (nconf.get("redis:tls")) {
    options.tls = {
        servername: host,
    };
}

let pubOptions = _.clone(options);
let subOptions = _.clone(options);

let pub = redis.createClient(port, host, pubOptions);
let sub = redis.createClient(port, host, subOptions);
io.adapter(socketIoRedis({ pubClient: pub, subClient: sub }));

// Connection to stored document details
const mongoUrl = nconf.get("mongo:endpoint");
const objectsCollectionName = nconf.get("mongo:collectionNames:objects");

const mongoManager = new utils.MongoManager(mongoUrl);

async function getOrCreateObject(id: string): Promise<boolean> {
    const db = await mongoManager.getDatabase();
    const collection = db.collection(objectsCollectionName);

    const dbObjectP = collection.findOne({ _id: id });
    return dbObjectP.then(
        (dbObject) => {
            if (dbObject) {
                return true;
            } else {
                // TODO should I inject a "new document" message in the stream?
                return collection.insertOne({ _id: id }).then(() => false);
            }
        });
}

/**
 * Retrieves revisions for the given document
 */
async function getRevisions(id: string): Promise<any[]> {
    return new Promise<any[]>((resolve, reject) => {
        request.get(
            { url: `${historian}/repos/${historianBranch}/commits?sha=${id}`, json: true },
            (error, response, body) => {
                if (error) {
                    reject(error);
                }
                if (response.statusCode !== 200) {
                    resolve([]);
                } else {
                    resolve(body);
                }
            });
    });
}

export interface IDocumentDetails {
    existing: boolean;

    version: string;

    sequenceNumber: number;

    distributedObjects: api.IDistributedObject[];

    pendingDeltas: api.ISequencedMessage[];

}

async function getDistributedObjects(id: string, version: string): Promise<api.IDistributedObject[]> {
    return Promise.reject("Not implemented");
}

async function getPendingDeltas(id: string, from: number): Promise<api.ISequencedMessage[]> {
    return Promise.reject("Not implemented");
}

async function getOrCreateDocument(id: string): Promise<IDocumentDetails> {
    const existingP = getOrCreateObject(id);

    const revisions = await getRevisions(id);
    const version = revisions.length > 0 ? revisions[0] : null;

    // If there has been a snapshot made use it to retrieve object state as well as any pending deltas. Otherwise
    // we just load all deltas
    let sequenceNumber: number;
    let distributedObjects: api.IDistributedObject[];

    if (version) {
        distributedObjects = await getDistributedObjects(id, version);
        return Promise.reject("Need to obtain sequence number from snapshot");
    } else {
        sequenceNumber = 0;
        distributedObjects = null;
    }

    const pendingDeltas = await getPendingDeltas(id, sequenceNumber);
    const existing = await existingP;

    return {
        distributedObjects,
        existing,
        pendingDeltas,
        sequenceNumber,
        version,
    };
}

// Producer used to publish messages
const producer = utils.kafkaProducer.create(kafkaLibrary, kafkaEndpoint, kafkaClientId, topic);
const throughput = new utils.ThroughputCounter(logger.info);

io.on("connection", (socket) => {
    // Map from client IDs on this connection to the object ID for them
    const connectionsMap: { [clientId: string]: string } = {};

    // Note connect is a reserved socket.io word so we use connectDocument to represent the connect request
    socket.on("connectDocument", (message: socketStorage.IConnect, response) => {
        // Join the room first to ensure the client will start receiving delta updates
        logger.info(`Client has requested to load ${message.id}`);

        const documentDetailsP = getOrCreateDocument(message.id);
        documentDetailsP.then(
            (documentDetails) => {
                socket.join(message.id, (joinError) => {
                    if (joinError) {
                        return response(joinError, null);
                    }

                    const clientId = moniker.choose();
                    connectionsMap[clientId] = message.id;

                    const connectedMessage: socketStorage.IConnected = {
                        clientId,
                        distributedObjects: documentDetails.distributedObjects,
                        existing: documentDetails.existing,
                        pendingDeltas: documentDetails.pendingDeltas,
                        sequenceNumber: documentDetails.sequenceNumber,
                        version: documentDetails.version,
                    };
                    response(null, connectedMessage);
                });
            }, (error) => {
                logger.error("Error fetching", error);
                response(error, null);
            });
    });

    // Message sent when a new operation is submitted to the router
    socket.on("submitOp", (clientId: string, message: api.IMessage, response) => {
        // Verify the user has connected on this object id
        if (!connectionsMap[clientId]) {
            return response("Invalid client ID", null);
        }

        const documentId = connectionsMap[clientId];
        const rawMessage: core.IRawOperationMessage = {
            clientId,
            documentId,
            operation: message,
            timestamp: Date.now(),
            type: core.RawOperationType,
            userId: null,
        };

        throughput.produce();
        producer.send(JSON.stringify(rawMessage), documentId).then(
            (responseMessage) => {
                response(null, responseMessage);
                throughput.acknolwedge();
            },
            (error) => {
                logger.error(error);
                response(error, null);
                throughput.acknolwedge();
            });
    });

    // Message sent to allow clients to update their sequence number
    socket.on("updateReferenceSequenceNumber", (clientId: string, sequenceNumber: number, response) => {
        // Verify the user has connected on this object id
        if (!connectionsMap[clientId]) {
            return response("Invalid object", null);
        }

        const documentId = connectionsMap[clientId];
        const message: core.IUpdateReferenceSequenceNumberMessage = {
            clientId,
            documentId,
            sequenceNumber,
            timestamp: Date.now(),
            type: core.UpdateReferenceSequenceNumberType,
            userId: null,
        };

        throughput.produce();
        producer.send(JSON.stringify(message), documentId).then(
            (responseMessage) => {
                response(null, responseMessage);
                throughput.acknolwedge();
            },
            (error) => {
                logger.error(error);
                response(error, null);
                throughput.acknolwedge();
            });
    });
});

export default io;
