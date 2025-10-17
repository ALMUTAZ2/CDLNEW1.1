import { Transformer, FinalConnection, ConnectionConfig, IndividualMeter } from '../types';

type ProcessedBreaker = {
    id: string;
    transformer: Transformer;
    number: string;
    meters: IndividualMeter[];
};

/**
 * Processes transformers to create a list of logical breakers.
 * This is crucial for re-combining meters that were split across two physical breakers back into a single entity for correct processing.
 */
function getProcessedBreakers(transformers: Transformer[]): ProcessedBreaker[] {
    const processedBreakers: ProcessedBreaker[] = [];
    const handledBreakers = new Set<string>(); // Key: "t{t.id}-b{b.id}"

    const allBreakersWithTransformer = transformers.flatMap(transformer =>
        transformer.breakers.map(breaker => ({ ...breaker, transformer }))
    );

    type BreakerWithTransformer = typeof allBreakersWithTransformer[0];
    const part1Meters = new Map<string, { breaker: BreakerWithTransformer, meter: IndividualMeter }>();

    allBreakersWithTransformer.forEach(breaker => {
        breaker.meters.forEach(meter => {
            if (meter.note === 'جزء 1') {
                const baseId = (meter.id as string).replace('_p1', '');
                part1Meters.set(baseId, { breaker, meter });
            }
        });
    });

    allBreakersWithTransformer.forEach(breaker2 => {
        const breaker2Key = `t${breaker2.transformer.id}-b${breaker2.id}`;
        if (handledBreakers.has(breaker2Key)) return;

        const part2Meter = breaker2.meters.find(m => m.note === 'جزء 2');
        if (part2Meter) {
            const baseId = (part2Meter.id as string).replace('_p2', '');
            if (part1Meters.has(baseId)) {
                const { breaker: breaker1, meter: meter1 } = part1Meters.get(baseId)!;
                const breaker1Key = `t${breaker1.transformer.id}-b${breaker1.id}`;
                handledBreakers.add(breaker1Key);
                handledBreakers.add(breaker2Key);

                const originalMeter = { ...meter1, id: baseId, cdl: meter1.cdl + part2Meter.cdl, note: undefined };
                const allMetersInPair = [
                    originalMeter,
                    ...breaker1.meters.filter(m => m.id !== meter1.id),
                    ...breaker2.meters.filter(m => m.id !== part2Meter.id)
                ];

                processedBreakers.push({
                    id: baseId,
                    transformer: breaker1.transformer,
                    number: `${breaker1.number} & ${breaker2.number}`,
                    meters: allMetersInPair,
                });
            }
        }
    });

    allBreakersWithTransformer.forEach(breaker => {
        const breakerKey = `t${breaker.transformer.id}-b${breaker.id}`;
        if (!handledBreakers.has(breakerKey) && breaker.meters.length > 0) {
            processedBreakers.push({
                id: `t${breaker.transformer.id}-b${breaker.id}`,
                transformer: breaker.transformer,
                number: String(breaker.number),
                meters: breaker.meters,
            });
        }
    });

    return processedBreakers.sort((a,b) => {
        if (a.transformer.id !== b.transformer.id) return a.transformer.id - b.transformer.id;
        const numA = parseInt(String(a.number).split('&')[0]);
        const numB = parseInt(String(b.number).split('&')[0]);
        return numA - numB;
    });
}

/**
 * Determines the connection configuration for a group of meters fed from a Distribution Panel (DP).
 * Based on Coincident Demand Load (CDL) in Amperes.
 */
function getDPConfig(cdl: number): ConnectionConfig {
    if (cdl <= 108) {
        return { source: 'DP', fuses: 1, customerCableCount: 1, customerCableSize: '70 mm²', mainFeederInfo: '1x 300 mm²' };
    } else if (cdl <= 184) {
        return { source: 'DP', fuses: 1, customerCableCount: 1, customerCableSize: '185 mm²', mainFeederInfo: '1x 300 mm²' };
    } else if (cdl <= 216) {
        return { source: 'DP', fuses: 2, customerCableCount: 2, customerCableSize: '70 mm²', mainFeederInfo: '1x 300 mm²' };
    } else { // Handles up to 248A
        return { source: 'DP', fuses: 2, customerCableCount: 2, customerCableSize: '185 mm²', mainFeederInfo: '1x 300 mm²' };
    }
}

/**
 * Determines the connection configuration for a heavy load meter fed directly from a Substation (SS).
 */
function getSSConfig(cdl: number): ConnectionConfig {
    if (cdl <= 248) {
        return { source: 'SS', fuses: 1, customerCableCount: 1, customerCableSize: '300 mm²', mainFeederInfo: 'Direct Feeder' };
    } else if (cdl <= 496) {
        return { source: 'SS', fuses: 2, customerCableCount: 2, customerCableSize: '300 mm²', mainFeederInfo: 'Direct Feeder' };
    } else {
        const cableCount = Math.ceil(cdl / 248);
        return { source: 'SS', fuses: cableCount, customerCableCount: cableCount, customerCableSize: '300 mm²', mainFeederInfo: 'Direct Feeder' };
    }
}

/**
 * Main function to calculate the final LV network connections based on the balanced distribution.
 */
export function calculateFinalConnections(transformers: Transformer[]): FinalConnection[] {
    const finalConnections: FinalConnection[] = [];
    const processedBreakers = getProcessedBreakers(transformers);

    processedBreakers.forEach(breaker => {
        // --- Step 1: Classify meters based on new rules ---
        const wholeCurrentMeters: IndividualMeter[] = []; // <= 150A, for grouping on DP
        const individualCT_DP_Meters: IndividualMeter[] = []; // 200A & 250A, individual connection from DP
        const heavyLoad_SS_Meters: IndividualMeter[] = []; // >= 300A, individual connection from SS

        breaker.meters.forEach(meter => {
            if (meter.capacity >= 300) {
                heavyLoad_SS_Meters.push(meter);
            } else if (meter.capacity >= 200) { // 200 or 250
                individualCT_DP_Meters.push(meter);
            } else { // <= 150
                wholeCurrentMeters.push(meter);
            }
        });

        // --- Step 2: Process Heavy Loads (Directly from SS) ---
        heavyLoad_SS_Meters.forEach(meter => {
            let meterBoxName = '1 صندوق CT (مخصص)';
            if (meter.capacity <= 400) meterBoxName = '1 صندوق CT (300/400A)';
            else if (meter.capacity <= 600) meterBoxName = '1 صندوق CT (500/600A)';
            else if (meter.capacity >= 800) meterBoxName = '1 صندوق CT (Remote)'; // As per spec

            finalConnections.push({
                id: `t${breaker.transformer.id}-b${breaker.number}-m${meter.id}`,
                transformerId: breaker.transformer.id,
                transformerName: `المحول ${breaker.transformer.id}`,
                breakerNumber: breaker.number,
                totalCDL: meter.cdl,
                meters: [meter],
                meterBoxes: meterBoxName,
                configuration: getSSConfig(meter.cdl)
            });
        });

        // --- Step 3: Process all DP-connected meters for this breaker ---
        let dpOutletCounter = 1;
        
        // --- Group and connect Whole-Current Meters (<= 150A) ---
        if (wholeCurrentMeters.length > 0) {
            const MAX_LOAD_PER_CONNECTION = 248;
            const sortedMeters = [...wholeCurrentMeters].sort((a, b) => b.cdl - a.cdl);
            const bins: { meters: IndividualMeter[], load: number }[] = [];

            // Best-fit bin packing algorithm
            for (const meter of sortedMeters) {
                let bestBinIndex = -1;
                let minRemainingSpace = Infinity;
                for (let i = 0; i < bins.length; i++) {
                    const remainingSpace = MAX_LOAD_PER_CONNECTION - bins[i].load;
                    if (meter.cdl <= remainingSpace && remainingSpace < minRemainingSpace) {
                        minRemainingSpace = remainingSpace;
                        bestBinIndex = i;
                    }
                }
                if (bestBinIndex !== -1) {
                    bins[bestBinIndex].meters.push(meter);
                    bins[bestBinIndex].load += meter.cdl;
                } else {
                    bins.push({ meters: [meter], load: meter.cdl });
                }
            }

            // Create FinalConnection objects from the packed bins
            for (const bin of bins) {
                const totalCDL = bin.load;
                const config = getDPConfig(totalCDL);
                const meterBoxes = `${Math.ceil(bin.meters.length / 2)} صندوق ثنائي`;
                
                let dpOutletDisplay: string;
                if (config.customerCableCount === 2) {
                    dpOutletDisplay = `${dpOutletCounter} & ${dpOutletCounter + 1}`;
                    dpOutletCounter += 2;
                } else {
                    dpOutletDisplay = String(dpOutletCounter);
                    dpOutletCounter += 1;
                }
                
                finalConnections.push({
                    id: `t${breaker.transformer.id}-b${breaker.number}-o${dpOutletDisplay.replace(' & ', '-')}`,
                    transformerId: breaker.transformer.id,
                    transformerName: `المحول ${breaker.transformer.id}`,
                    breakerNumber: breaker.number,
                    dpOutletNumber: dpOutletDisplay,
                    totalCDL: totalCDL,
                    meters: bin.meters,
                    meterBoxes: meterBoxes,
                    configuration: config,
                });
            }
        }
        
        // --- Connect Individual CT Meters (200A & 250A) ---
        individualCT_DP_Meters.sort((a, b) => b.cdl - a.cdl).forEach(meter => {
            const totalCDL = meter.cdl;
            const config = getDPConfig(totalCDL);
            
            let dpOutletDisplay: string;
            if (config.customerCableCount === 2) {
                dpOutletDisplay = `${dpOutletCounter} & ${dpOutletCounter + 1}`;
                dpOutletCounter += 2;
            } else {
                dpOutletDisplay = String(dpOutletCounter);
                dpOutletCounter += 1;
            }
            
            finalConnections.push({
                id: `t${breaker.transformer.id}-b${breaker.number}-m${meter.id}`,
                transformerId: breaker.transformer.id,
                transformerName: `المحول ${breaker.transformer.id}`,
                breakerNumber: breaker.number,
                dpOutletNumber: dpOutletDisplay,
                totalCDL: totalCDL,
                meters: [meter],
                meterBoxes: '1 صندوق CT (200/250A)',
                configuration: config,
            });
        });
    });

    return finalConnections;
}
