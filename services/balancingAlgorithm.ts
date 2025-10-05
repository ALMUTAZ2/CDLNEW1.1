import { MeterGroup, IndividualMeter, Breaker, Transformer, TransformerType, DistributionResults, DistributionSummary } from '../types';
import { MAX_BREAKER_CAPACITY, TRANSFORMER_TYPES } from '../constants';

// --- Helper Functions ---
const updateBreakerStats = (breaker: Breaker) => {
    breaker.load = breaker.meters.reduce((sum, meter) => sum + meter.cdl, 0);
    let maxCapacity = 310; // Default capacity for comparison

    // **CRITICAL**: For dedicated breakers serving 1600A or 2500A meters,
    // the utilization must be calculated against the meter's own capacity, not the standard breaker capacity.
    if (breaker.dedicated && breaker.meters.length === 1) {
        const meterCapacity = breaker.meters[0].capacity;
        if (meterCapacity === 1600 || meterCapacity === 2500) {
            maxCapacity = meterCapacity;
        }
    }

    breaker.utilizationPercent = maxCapacity > 0 ? (breaker.load / maxCapacity) * 100 : 0;
    
    // Clear and update descriptive sets
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
            // Check if it's one of the special large meters
            if (meterCapacity === 1600 || meterCapacity === 2500) {
                return b.load > meterCapacity; // Compare against its own capacity
            }
        }
        // For all other breakers, use the standard capacity
        return b.load > MAX_BREAKER_CAPACITY;
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
        overloadedTransformers: transformers.filter(t => t.assignedLoad > t.type.safeLoad + 0.01).length, // Use a small tolerance
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

// --- Core Logic ---

// Phase 1: Planning
const planTransformersForLoad = (load: number): TransformerType[] => {
    const plannedTypes: TransformerType[] = [];
    let remainingLoad = load * 1.00001; // Add a 15% planning safety margin to prevent 99% usage
    
    const sortedTypes = [...TRANSFORMER_TYPES].sort((a, b) => b.safeLoad - a.safeLoad);
    const largestType = sortedTypes[0];

    if (largestType) {
        while (remainingLoad > largestType.safeLoad) {
            plannedTypes.push(largestType);
            remainingLoad -= largestType.safeLoad;
        }
    }

    if (remainingLoad > 0) {
        const bestFit = [...TRANSFORMER_TYPES]
            .sort((a, b) => a.safeLoad - b.safeLoad)
            .find(t => t.safeLoad >= remainingLoad);
        
        if (bestFit) {
            plannedTypes.push(bestFit);
        } else if (largestType) {
            plannedTypes.push(largestType);
        }
    }
    
    return plannedTypes;
};


// Phase 2: Placement helpers
const findBestBreakerForEvenDistribution = (meter: IndividualMeter, transformers: Transformer[]): { breaker: Breaker; parent: Transformer } | null => {
    let bestOption: { breaker: Breaker; parent: Transformer; score: number } | null = null;

    for (const parent of transformers.filter(t => !t.isDedicated)) {
        if (parent.assignedLoad + meter.cdl > parent.type.safeLoad) continue;

        for (const breaker of parent.breakers) {
            if (breaker.dedicated || breaker.load + meter.cdl > MAX_BREAKER_CAPACITY) continue;
            
            const score = breaker.load; // Prioritize the least-loaded breaker
            if (bestOption === null || score < bestOption.score) {
                bestOption = { breaker, parent, score };
            }
        }
    }
    return bestOption;
};

const findBestBreakerPairForEvenDistribution = (meter: IndividualMeter, transformers: Transformer[]): { b1: Breaker; b2: Breaker; parent: Transformer } | null => {
    const halfLoad = meter.cdl / 2;
    let bestPair: { b1: Breaker; b2: Breaker; parent: Transformer; score: number } | null = null;

    for (const parent of transformers.filter(t => !t.isDedicated)) {
        if (parent.assignedLoad + meter.cdl > parent.type.safeLoad) continue;

        const availableSlots = parent.breakers.filter(b => !b.dedicated && b.load + halfLoad <= MAX_BREAKER_CAPACITY);
        if (availableSlots.length < 2) continue;

        for (let i = 0; i < availableSlots.length; i++) {
            for (let j = i + 1; j < availableSlots.length; j++) {
                const b1 = availableSlots[i];
                const b2 = availableSlots[j];
                const combinedLoad = b1.load + b2.load;
                if (bestPair === null || combinedLoad < bestPair.score) {
                    bestPair = { b1, b2, parent, score: combinedLoad };
                }
            }
        }
    }
    return bestPair;
};

// Adaptive fallback function
const addBestFitTransformerForMeter = (meter: IndividualMeter, transformers: Transformer[], transformerIdCounter: number): number => {
    const bestFitType = [...TRANSFORMER_TYPES]
        .sort((a, b) => a.safeLoad - b.safeLoad)
        .find(t => t.safeLoad >= meter.cdl) || TRANSFORMER_TYPES[TRANSFORMER_TYPES.length - 1];
    transformers.push(createNewTransformer(bestFitType, transformerIdCounter));
    return transformerIdCounter + 1;
};

// Phase 3: Final Balancing & Consolidation
const balanceTransformerInternally = (transformer: Transformer) => {
    if (transformer.isDedicated) return;
    for (let i = 0; i < 5; i++) {
        const breakers = transformer.breakers.filter(b => b.meters.length > 0 && !b.dedicated).sort((a, b) => a.load - b.load);
        if (breakers.length < 2) break;
        const leastLoaded = breakers[0];
        const mostLoaded = breakers[breakers.length - 1];
        if (mostLoaded.load - leastLoaded.load < 20) break;
        const movableMeter = mostLoaded.meters.sort((a, b) => a.cdl - b.cdl).find(m => leastLoaded.load + m.cdl <= MAX_BREAKER_CAPACITY);
        if (movableMeter) {
            mostLoaded.meters = mostLoaded.meters.filter(m => m.id !== movableMeter.id);
            leastLoaded.meters.push(movableMeter);
            updateBreakerStats(mostLoaded);
            updateBreakerStats(leastLoaded);
        } else {
            break;
        }
    }
};

const consolidateSingleMeterBreakers = (transformers: Transformer[]) => {
    let moved = true;
    let iterations = 0;
    const maxIterations = 20;

    while (moved && iterations < maxIterations) {
        moved = false;
        iterations++;
        const singleMeterBreakers: { breaker: Breaker; parent: Transformer; meter: IndividualMeter }[] = [];
        transformers.forEach(parent => {
            parent.breakers.forEach(breaker => {
                if (breaker.meters.length === 1 && !breaker.dedicated && breaker.meters[0].capacity >= 20 && breaker.meters[0].capacity <= 300) {
                    singleMeterBreakers.push({ breaker, parent, meter: breaker.meters[0] });
                }
            });
        });

        if (singleMeterBreakers.length === 0) break;
        singleMeterBreakers.sort((a,b) => a.breaker.load - b.breaker.load);

        for (const source of singleMeterBreakers) {
            const { breaker: sourceBreaker, parent: sourceParent, meter } = source;
            let bestTarget: { breaker: Breaker; parent: Transformer; score: number } | null = null;
            
            for (const targetParent of transformers.filter(t => !t.isDedicated)) {
                if (targetParent.id !== sourceParent.id && targetParent.assignedLoad + meter.cdl > targetParent.type.safeLoad) continue;
                for (const targetBreaker of targetParent.breakers) {
                    if ((targetBreaker.id === sourceBreaker.id && targetParent.id === sourceParent.id) || targetBreaker.dedicated || targetBreaker.meters.length === 0) continue;
                    if (targetBreaker.load + meter.cdl <= MAX_BREAKER_CAPACITY) {
                        const score = targetBreaker.load;
                        if (bestTarget === null || score < bestTarget.score) {
                            bestTarget = { breaker: targetBreaker, parent: targetParent, score };
                        }
                    }
                }
            }

            if (bestTarget) {
                bestTarget.breaker.meters.push(meter);
                sourceBreaker.meters = [];
                updateAllStats(transformers);
                moved = true;
                break;
            }
        }
    }
};


// --- Main Distribution Algorithm ---
export const performBalancedDistributionMultiTransformer = (meterGroups: MeterGroup[]): DistributionResults => {
    const totalLoadAll = meterGroups.reduce((sum, meter) => sum + meter.totalCDL, 0);
    const individualMeters: IndividualMeter[] = meterGroups.flatMap(group =>
        Array.from({ length: group.count }, (_, i) => ({ ...group, id: `${group.id}_${i}`, cdl: group.cdlPerMeter }))
    );

    const dedicatedMeters = individualMeters.filter(m => m.capacity >= 1600);
    const generalMeters = individualMeters.filter(m => m.capacity < 1600);
    const generalMetersTotalLoad = generalMeters.reduce((sum, m) => sum + m.cdl, 0);
    
    let transformerIdCounter = 1;
    const finalTransformers: Transformer[] = [];

    // Step 1: Handle Dedicated Meters first with single main breakers
    dedicatedMeters.forEach(meter => {
        let selectedType: TransformerType;
        if (meter.capacity === 1600) {
            selectedType = TRANSFORMER_TYPES.find(t => t.capacity === 1000)!;
        } else { // 2500A
            selectedType = TRANSFORMER_TYPES.find(t => t.capacity === 1500)!;
        }
        
        const mainBreaker: Breaker = {
            id: 1, number: 1, load: 0, meters: [meter], utilizationPercent: 0,
            meterTypes: new Set(), categories: new Set(), timePatterns: new Set(),
            dedicated: true, dedicatedFor: `لعداد ${meter.capacity}A`
        };

        const transformer: Transformer = {
            id: transformerIdCounter++,
            type: selectedType,
            assignedLoad: 0,
            breakers: [mainBreaker], // Only one main breaker
            isDedicated: true,
            dedicatedFor: `لعداد ${meter.capacity}A`,
        };
        
        finalTransformers.push(transformer);
    });

    // Step 2: Plan infrastructure for general meters
    const plannedTypes = planTransformersForLoad(generalMetersTotalLoad);
    plannedTypes.forEach(type => {
        finalTransformers.push(createNewTransformer(type, transformerIdCounter++));
    });

    // Step 3: Distribute general meters
    const metersToPlace = generalMeters.sort((a, b) => {
        const isADual = a.capacity >= 400 && a.capacity <= 800;
        const isBDual = b.capacity >= 400 && b.capacity <= 800;
        if (isADual !== isBDual) return isADual ? -1 : 1;
        return b.cdl - a.cdl;
    });

    metersToPlace.forEach(meter => {
        let placed = false;
        if (meter.capacity >= 400 && meter.capacity <= 800) {
            let bestPair = findBestBreakerPairForEvenDistribution(meter, finalTransformers);
            if (bestPair) {
                bestPair.b1.meters.push({ ...meter, id: `${meter.id}_p1`, cdl: meter.cdl/2, note: 'جزء 1' });
                bestPair.b2.meters.push({ ...meter, id: `${meter.id}_p2`, cdl: meter.cdl/2, note: 'جزء 2' });
                placed = true;
            }
        } else {
            let bestOption = findBestBreakerForEvenDistribution(meter, finalTransformers);
            if (bestOption) {
                bestOption.breaker.meters.push(meter);
                placed = true;
            }
        }

        if (!placed) {
            transformerIdCounter = addBestFitTransformerForMeter(meter, finalTransformers, transformerIdCounter);
            if (meter.capacity >= 400 && meter.capacity <= 800) {
                 const bestPair = findBestBreakerPairForEvenDistribution(meter, finalTransformers)!;
                 bestPair.b1.meters.push({ ...meter, id: `${meter.id}_p1`, cdl: meter.cdl/2, note: 'جزء 1' });
                 bestPair.b2.meters.push({ ...meter, id: `${meter.id}_p2`, cdl: meter.cdl/2, note: 'جزء 2' });
            } else {
                 const bestOption = findBestBreakerForEvenDistribution(meter, finalTransformers)!;
                 bestOption.breaker.meters.push(meter);
            }
        }
        updateAllStats(finalTransformers);
    });
    
    // Step 4: Final balancing and consolidation
    finalTransformers.forEach(balanceTransformerInternally);
    updateAllStats(finalTransformers);
    consolidateSingleMeterBreakers(finalTransformers);

    // Step 5: Final Cleanup and Summary
    const activeTransformers = finalTransformers.filter(t => t.breakers.some(b => b.meters.length > 0) || t.isDedicated);
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