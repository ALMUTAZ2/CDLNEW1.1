
import { MeterGroup, IndividualMeter, Breaker, Transformer, TransformerType, DistributionResults, DistributionSummary } from '../types';
import { MAX_BREAKER_CAPACITY, TRANSFORMER_TYPES, MAX_BREAKER_SAFE_CAPACITY } from '../constants';

// --- Helper Functions ---
const updateBreakerStats = (breaker: Breaker) => {
    breaker.load = breaker.meters.reduce((sum, meter) => sum + meter.cdl, 0);
    let maxCapacity = MAX_BREAKER_CAPACITY;

    if (breaker.dedicated && breaker.meters.length === 1) {
        const meterCapacity = breaker.meters[0].capacity;
        if (meterCapacity === 1600 || meterCapacity === 2500) {
            maxCapacity = meterCapacity;
        }
    }

    breaker.utilizationPercent = maxCapacity > 0 ? (breaker.load / maxCapacity) * 100 : 0;
    
    breaker.meterTypes.clear();
    breaker.categories.clear();
    breaker.timePatterns.clear();
    breaker.meters.forEach(meter => {
        breaker.meterTypes.add(meter.typeName);
        breaker.categories.add(meter.category);
        breaker.timePatterns.add(meter.timePattern);
    });
};

const updateAllStats = (transformers: Transformer[]) => {
    transformers.forEach(t => {
        t.breakers.forEach(updateBreakerStats);
        t.assignedLoad = t.breakers.reduce((sum, b) => sum + b.load, 0);
    });
};

const createNewTransformer = (type: TransformerType, id: number): Transformer => ({
    id: id,
    type: type,
    assignedLoad: 0,
    breakers: Array.from({ length: type.breakers }, (_, i) => ({
        id: i + 1, number: i + 1, load: 0, meters: [], utilizationPercent: 0,
        meterTypes: new Set(), categories: new Set(), timePatterns: new Set(),
    })),
});

// --- Summary & Scoring ---
const calculateOverallBalanceScore = (transformers: Transformer[]): number => {
    const allBreakers = transformers.filter(t => !t.isDedicated).flatMap(t => t.breakers).filter(b => b.meters.length > 0);
    if (allBreakers.length < 2) return 100;
    const utils = allBreakers.map(b => b.utilizationPercent);
    const avg = utils.reduce((sum, v) => sum + v, 0) / utils.length;
    const stdDev = Math.sqrt(utils.map(x => Math.pow(x - avg, 2)).reduce((a, b) => a + b) / utils.length);
    return Math.max(0, Math.min(100, 100 - stdDev * 2));
};

const getEfficiency = (transformers: Transformer[]): number => {
    const totalUsed = transformers.reduce((s, t) => s + t.assignedLoad, 0);
    const totalCapacity = transformers.reduce((s, t) => s + t.type.safeLoad, 0);
    return totalCapacity > 0 ? (totalUsed / totalCapacity * 100) : 0;
};

const calculateMultiTransformerSummary = (transformers: Transformer[], totalLoad: number, balanceScore: number, originalMeters: MeterGroup[]): DistributionSummary => {
    const allBreakers = transformers.flatMap(t => t.breakers).filter(b => b.meters.length > 0);
    const utils = allBreakers.map(b => b.utilizationPercent);
    const totalMeters = originalMeters.reduce((sum, m) => sum + m.count, 0);
    
    const dualBreakerMeterParts = new Set(allBreakers.flatMap(b => b.meters).filter(m => m.note?.includes('جزء 2')).map(m => String(m.id).split('_p')[0])).size;
    const distributionEntries = allBreakers.length - dualBreakerMeterParts;

    const overloadedBreakers = allBreakers.filter(b => {
        if (b.dedicated && b.meters.length === 1) {
            const meterCapacity = b.meters[0].capacity;
            if (meterCapacity === 1600 || meterCapacity === 2500) {
                return b.load > meterCapacity;
            }
        }
        return b.load > MAX_BREAKER_SAFE_CAPACITY;
    }).length;

    const transformerCapacities: {[key: string]: number} = {};
    transformers.forEach(t => {
        transformerCapacities[t.type.capacity] = (transformerCapacities[t.type.capacity] || 0) + 1;
    });
    return {
        totalTransformers: transformers.length,
        totalBreakers: allBreakers.length,
        distributionEntries: distributionEntries,
        totalMeters: totalMeters,
        totalLoad: totalLoad.toFixed(1),
        totalLoadKVA: (totalLoad * 0.4 * 1.73).toFixed(1),
        overloadedBreakers: overloadedBreakers,
        overloadedTransformers: transformers.filter(t => t.assignedLoad > t.type.safeLoad + 0.01).length,
        maxUtilization: (utils.length > 0 ? Math.max(...utils) : 0).toFixed(1),
        minUtilization: (utils.length > 0 ? Math.min(...utils) : 0).toFixed(1),
        avgUtilization: (utils.length > 0 ? utils.reduce((s, v) => s + v, 0) / utils.length : 0).toFixed(1),
        balanceScore: balanceScore.toFixed(1),
        efficiency: getEfficiency(transformers).toFixed(1),
        transformerDetails: Object.entries(transformerCapacities)
            .sort(([a], [b]) => parseInt(b) - parseInt(a))
            .map(([capacity, count]) => `${count}x ${capacity} KVA`).join('<br>')
    };
};

// --- Core Logic Helpers ---

const findBestBreakerPairInTransformer = (meter: IndividualMeter, transformer: Transformer): { b1: Breaker; b2: Breaker } | null => {
    const halfLoad = meter.cdl / 2;
    let bestPair: { b1: Breaker; b2: Breaker; score: number } | null = null;
    const availableSlots = transformer.breakers.filter(b => !b.dedicated && b.load + halfLoad <= MAX_BREAKER_SAFE_CAPACITY);
    if (availableSlots.length < 2) return null;

    for (let i = 0; i < availableSlots.length; i++) {
        for (let j = i + 1; j < availableSlots.length; j++) {
            const b1 = availableSlots[i];
            const b2 = availableSlots[j];
            const combinedLoad = b1.load + b2.load;
            if (bestPair === null || combinedLoad < bestPair.score) {
                bestPair = { b1, b2, score: combinedLoad };
            }
        }
    }
    return bestPair ? { b1: bestPair.b1, b2: bestPair.b2 } : null;
};

const balanceTransformerInternally = (transformer: Transformer) => {
    if (transformer.isDedicated) return;
    for (let i = 0; i < 5; i++) { // Iterate a few times for stability
        const breakers = transformer.breakers.filter(b => b.meters.length > 0 && !b.dedicated).sort((a, b) => a.load - b.load);
        if (breakers.length < 2) break;
        const leastLoaded = breakers[0];
        const mostLoaded = breakers[breakers.length - 1];
        if (mostLoaded.load - leastLoaded.load < 20) break; // If already balanced, stop
        
        const movableMeter = mostLoaded.meters
            .sort((a, b) => a.cdl - b.cdl)
            .find(m => leastLoaded.load + m.cdl <= MAX_BREAKER_SAFE_CAPACITY);

        if (movableMeter) {
            mostLoaded.meters = mostLoaded.meters.filter(m => m.id !== movableMeter.id);
            leastLoaded.meters.push(movableMeter);
            updateBreakerStats(mostLoaded);
            updateBreakerStats(leastLoaded);
        } else {
            break; // No suitable meter to move
        }
    }
};

// --- Main Distribution Algorithm ---
export const performBalancedDistributionMultiTransformer = (meterGroups: MeterGroup[]): DistributionResults => {
    // Stage 1: Initial Sorting and Classification
    const totalLoadAll = meterGroups.reduce((sum, meter) => sum + meter.totalCDL, 0);
    const allMeters: IndividualMeter[] = meterGroups.flatMap(group =>
        Array.from({ length: group.count }, (_, i) => ({ ...group, id: `${group.id}_${i}`, cdl: group.cdlPerMeter }))
    );

    const dedicatedMeters = allMeters.filter(m => m.capacity >= 1600);
    let generalMeters = allMeters.filter(m => m.capacity < 1600);
    generalMeters.sort((a, b) => b.cdl - a.cdl); // Sort once, largest first

    let transformerIdCounter = 1;
    const finalTransformers: Transformer[] = [];

    // Handle Dedicated "Giant" Meters first
    dedicatedMeters.forEach(meter => {
        const selectedType = meter.capacity === 1600
            ? TRANSFORMER_TYPES.find(t => t.capacity === 1000)!
            : TRANSFORMER_TYPES.find(t => t.capacity === 1500)!;
        
        const transformer = createNewTransformer(selectedType, transformerIdCounter++);
        transformer.isDedicated = true;
        transformer.dedicatedFor = `لعداد ${meter.capacity}A`;
        const mainBreaker = transformer.breakers[0];
        mainBreaker.dedicated = true;
        mainBreaker.dedicatedFor = `لعداد ${meter.capacity}A`;
        mainBreaker.meters.push(meter);
        finalTransformers.push(transformer);
    });

    // Stages 2 & 3: Iterative Transformer Filling and Internal Distribution
    while (generalMeters.length > 0) {
        // a. Select the most optimal transformer for the remaining load
        const remainingLoad = generalMeters.reduce((sum, m) => sum + m.cdl, 0);
        const sortedTypes = [...TRANSFORMER_TYPES].sort((a, b) => a.safeLoad - b.safeLoad);
        const bestFitType = sortedTypes.find(t => t.safeLoad >= remainingLoad) || sortedTypes[sortedTypes.length - 1];
        const currentTransformer = createNewTransformer(bestFitType, transformerIdCounter++);
        finalTransformers.push(currentTransformer);

        // b. Select which meters from the general pool will go into this transformer
        const metersForThisTx: IndividualMeter[] = [];
        const nextGeneralMeters: IndividualMeter[] = [];
        let currentTxLoad = 0;
        for (const meter of generalMeters) {
            if (currentTxLoad + meter.cdl <= currentTransformer.type.safeLoad) {
                metersForThisTx.push(meter);
                currentTxLoad += meter.cdl;
            } else {
                nextGeneralMeters.push(meter);
            }
        }
        
        // c. Distribute the selected meters precisely within the current transformer
        const largeMeters = metersForThisTx.filter(m => m.capacity >= 400 && m.capacity < 1600);
        const normalMeters = metersForThisTx.filter(m => m.capacity < 400);
        let unplacedMeters: IndividualMeter[] = [];

        // Handle large (dual-breaker) meters first
        largeMeters.forEach(meter => {
            const bestPair = findBestBreakerPairInTransformer(meter, currentTransformer);
            if (bestPair) {
                bestPair.b1.meters.push({ ...meter, id: `${meter.id}_p1`, cdl: meter.cdl / 2, note: 'جزء 1' });
                bestPair.b2.meters.push({ ...meter, id: `${meter.id}_p2`, cdl: meter.cdl / 2, note: 'جزء 2' });
                
                // NEW: Mark breakers as dedicated to this split load so no other meters are added.
                bestPair.b1.dedicated = true;
                bestPair.b1.dedicatedFor = `لعداد مقسم ${meter.capacity}A`;
                bestPair.b2.dedicated = true;
                bestPair.b2.dedicatedFor = `لعداد مقسم ${meter.capacity}A`;

                updateBreakerStats(bestPair.b1);
                updateBreakerStats(bestPair.b2);
            } else {
                unplacedMeters.push(meter); // Cannot fit, return to pool
            }
        });
        
        // Handle normal meters using the "Target Load" and advanced scoring algorithm
        if (normalMeters.length > 0) {
            const totalNormalLoad = normalMeters.reduce((s, m) => s + m.cdl, 0);
            const availableBreakers = currentTransformer.breakers.filter(b => !b.dedicated);
            
            // Re-implementing the "minimum required breakers" logic as per user's explicit request
            const minBreakersNeeded = Math.ceil(totalNormalLoad / MAX_BREAKER_SAFE_CAPACITY);
            const numTargetBreakers = Math.min(minBreakersNeeded, availableBreakers.length);
            const targetBreakers = availableBreakers.slice(0, numTargetBreakers);


            if (targetBreakers.length > 0) {
                const targetLoad = totalNormalLoad / targetBreakers.length;

                normalMeters.forEach(meter => {
                    let bestBreaker: Breaker | null = null;
                    let bestScore = -Infinity;

                    for (const breaker of targetBreakers) {
                        if (breaker.load + meter.cdl <= MAX_BREAKER_SAFE_CAPACITY) {
                            const newLoad = breaker.load + meter.cdl;
                            const targetScore = 1000 - Math.abs(newLoad - targetLoad);
                            const otherBreakerLoads = targetBreakers.filter(b => b.id !== breaker.id).map(b => b.load);
                            const newLoads = [...otherBreakerLoads, newLoad];
                            const newAvg = newLoads.reduce((s, v) => s + v, 0) / newLoads.length;
                            const newStdDev = Math.sqrt(newLoads.map(x => Math.pow(x - newAvg, 2)).reduce((a, b) => a + b) / newLoads.length);
                            const balanceScore = (50 - newStdDev) * 10;
                            const hasCategory = breaker.categories.has(meter.category);
                            const diversityScore = !hasCategory ? 25 : 0;
                            const fillScore = 50 - breaker.load;
                            const score = targetScore + balanceScore + diversityScore + fillScore;

                            if (score > bestScore) {
                                bestScore = score;
                                bestBreaker = breaker;
                            }
                        }
                    }

                    if (bestBreaker) {
                        bestBreaker.meters.push(meter);
                        updateBreakerStats(bestBreaker);
                    } else {
                        unplacedMeters.push(meter);
                    }
                });
            } else {
                unplacedMeters.push(...normalMeters);
            }
        }
        
        generalMeters = [...nextGeneralMeters, ...unplacedMeters].sort((a, b) => b.cdl - a.cdl);
    }
    
    // Stage 4: Final Balancing and Summary Generation
    updateAllStats(finalTransformers);
    finalTransformers.forEach(balanceTransformerInternally);

    const activeTransformers = finalTransformers.filter(t => t.breakers.some(b => b.meters.length > 0));
    activeTransformers.forEach((t, i) => t.id = i + 1);
    updateAllStats(activeTransformers);
    
    const balanceScore = calculateOverallBalanceScore(activeTransformers);
    const summary = calculateMultiTransformerSummary(activeTransformers, totalLoadAll, balanceScore, meterGroups);
    
    return {
        totalLoad: totalLoadAll,
        transformers: activeTransformers,
        balanceScore,
        summary
    };
};