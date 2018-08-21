import * as core from "../core";
import { INode } from "../services";
import { MongoManager } from "./mongo";

/**
 * MongoDB implementation of IDatabaseManager
 */
export class MongoDatabaseManager implements core.IDatabaseManager {

    constructor(
        private mongoManager: MongoManager,
        private nodeCollectionName: string,
        private documentsCollectionName: string,
        private deltasCollectionName: string) {
    }

    public async getNodeCollection(): Promise<core.ICollection<INode>> {
        return this.getCollection<INode>(this.nodeCollectionName);
    }

    public async getDocumentCollection(): Promise<core.ICollection<core.IDocument>> {
        return this.getCollection<core.IDocument>(this.documentsCollectionName);
    }

    public async getDeltaCollection(
        tenantId: string,
        documentId: string): Promise<core.ICollection<core.ISequencedOperationMessage>> {
        return this.getCollection<core.ISequencedOperationMessage>(this.deltasCollectionName);
    }

    private async getCollection<T>(name: string) {
        const db = await this.mongoManager.getDatabase();
        return db.collection<T>(name);
    }
}
