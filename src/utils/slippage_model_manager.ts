import { BigNumber } from '@0x/utils';

import {
    SLIPPAGE_MODEL_REFRESH_INTERVAL_MS,
    SLIPPAGE_MODEL_S3_BUCKET_NAME,
    SLIPPAGE_MODEL_S3_FILE_NAME,
} from '../config';
import { ONE_IN_BASE_POINTS } from '../constants';
import { logger } from '../logger';
import { schemas } from '../schemas';
import { GetSwapQuoteResponseLiquiditySource } from '../types';

import { pairUtils } from './pair_utils';
import { S3Client } from './s3_client';
import { schemaUtils } from './schema_utils';

interface SlippageModel {
    token0: string;
    token1: string;
    source: string;
    slippageCoefficient: number;
    volumeCoefficient: number;
    intercept: number;
}

type SlippageModelCacheForPair = Map<string, SlippageModel>;
type SlippageModelCache = Map<string, SlippageModelCacheForPair>;

const createSlippageModelCache = (slippageModelFileContent: string, logLabels: {}): SlippageModelCache => {
    const slippageModelList: SlippageModel[] = JSON.parse(slippageModelFileContent);
    schemaUtils.validateSchema(slippageModelList, schemas.slippageModelFileSchema);
    const cache: SlippageModelCache = new Map();
    slippageModelList.forEach((slippageModel) => {
        const pairKey = pairUtils.toKey(slippageModel.token0, slippageModel.token1);
        if (!pairKey.startsWith(slippageModel.token0.toLowerCase())) {
            logger.warn(
                {
                    ...logLabels,
                    token0: slippageModel.token0,
                    token1: slippageModel.token1,
                    source: slippageModel.source,
                },
                'Invalid slippage model.',
            );
            return;
        }

        if (!cache.has(pairKey)) {
            cache.set(pairKey, new Map());
        }
        cache.get(pairKey)!.set(slippageModel.source, {
            token0: slippageModel.token0.toLowerCase(),
            token1: slippageModel.token1.toLowerCase(),
            source: slippageModel.source,
            slippageCoefficient: slippageModel.slippageCoefficient,
            volumeCoefficient: slippageModel.volumeCoefficient,
            intercept: slippageModel.intercept,
        });
    });
    return cache;
};

const calculateExpectedSlippageForModel = (
    buyToken: string,
    sellToken: string,
    buyAmount: BigNumber,
    sellAmount: BigNumber,
    slippageInBps: BigNumber,
    slippageModel: SlippageModel,
): BigNumber => {
    let expectedSlippage: BigNumber = slippageInBps
        .times(slippageModel.slippageCoefficient)
        .plus(slippageModel.intercept);

    if (slippageModel.token0 === buyToken.toLowerCase()) {
        expectedSlippage = expectedSlippage.plus(buyAmount.times(slippageModel.volumeCoefficient));
    } else if (slippageModel.token0 === sellToken.toLowerCase()) {
        expectedSlippage = expectedSlippage.plus(sellAmount.times(slippageModel.volumeCoefficient));
    }
    return expectedSlippage;
};

/**
 * SlippageModelManager caches slippage model data in memory and keep in sync with the file in S3 bucket
 */
export class SlippageModelManager {
    private _lastRefreshed!: Date;
    private _cachedSlippageModel!: SlippageModelCache;

    constructor(private readonly _s3Client: S3Client) {
        this._resetCache();
    }

    /**
     * Initialize and set up periodical refreshing
     */
    public async initializeAsync(): Promise<void> {
        if (SLIPPAGE_MODEL_S3_BUCKET_NAME === undefined) {
            return;
        }

        await this._refreshAsync();

        setInterval(async () => {
            await this._refreshAsync();
        }, SLIPPAGE_MODEL_REFRESH_INTERVAL_MS);
    }

    public calculateExpectedSlippage(
        buyToken: string,
        sellToken: string,
        buyAmount: BigNumber,
        sellAmount: BigNumber,
        slippageRate: number,
        sources: GetSwapQuoteResponseLiquiditySource[],
    ): BigNumber {
        const slippageInBps = new BigNumber(slippageRate * ONE_IN_BASE_POINTS);
        let expectedSlippage: BigNumber = new BigNumber(0);
        sources.forEach((source) => {
            if (source.proportion.isGreaterThan(0)) {
                const slippageModel = this._getCachedModel(buyToken, sellToken, source.name);
                if (slippageModel !== undefined) {
                    const expectedSlippageOfSource = calculateExpectedSlippageForModel(
                        buyToken,
                        sellToken,
                        buyAmount,
                        sellAmount,
                        slippageInBps,
                        slippageModel,
                    );
                    expectedSlippage = expectedSlippage.plus(source.proportion.times(expectedSlippageOfSource));
                }
            }
        });
        return expectedSlippage;
    }

    /**
     * Get the cached slippage model data for a specific pair and source
     * @param tokenA Address of one token
     * @param tokenB Address of another token
     * @param source Name of AMM source
     * @returns Slippage model
     */
    private _getCachedModel(tokenA: string, tokenB: string, sourceName: string): SlippageModel | undefined {
        const pairKey = pairUtils.toKey(tokenA, tokenB);
        if (this._cachedSlippageModel.has(pairKey)) {
            return this._cachedSlippageModel.get(pairKey)!.get(sourceName);
        }
        return undefined;
    }

    /**
     * Reset the cache and its timestamp
     */
    private _resetCache(): void {
        this._cachedSlippageModel = new Map();
        this._lastRefreshed = new Date(0);
    }

    /**
     * Refresh the cached data by reloading the slippage model data file from S3
     * if the file has been updated since `this._lastRefreshed`.
     */
    private async _refreshAsync(): Promise<void> {
        const bucket: string = SLIPPAGE_MODEL_S3_BUCKET_NAME!;
        const fileName: string = SLIPPAGE_MODEL_S3_FILE_NAME;
        const refreshTime = new Date();

        try {
            const { exists: doesFileExist, lastModified } = await this._s3Client.hasFileAsync(bucket, fileName);
            if (!doesFileExist) {
                this._resetCache();
                return;
            }

            if (lastModified! <= this._lastRefreshed) {
                return;
            }

            logger.info({ bucket, fileName, refreshTime }, `Start refreshing slippage models.`);

            const { content, lastModified: lastRefreshed } = await this._s3Client.getFileContentAsync(bucket, fileName);
            this._cachedSlippageModel = createSlippageModelCache(content, { bucket, fileName, refreshTime });
            this._lastRefreshed = lastRefreshed;

            logger.info({ bucket, fileName, refreshTime }, `Successfully refreshed slippage models.`);
        } catch (error) {
            logger.error(
                { bucket, fileName, refreshTime, errorMessage: error.message },
                `Failed to refresh slippage models.`,
            );
        }
    }
}
