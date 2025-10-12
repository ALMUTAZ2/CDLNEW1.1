import React, { useMemo } from 'react';
import { DistributionResults, Transformer, Breaker, IndividualMeter, DistributionSummary } from '../types';

interface ResultsSectionProps {
    results: DistributionResults;
}

// Define a type for the processed rows to be displayed
type DisplayRow = {
    id: string;
    isMerged: boolean;
    transformerInfo: string;
    breakerNumber: string;
    categories: string;
    meterCount: number;
    load: string;
    utilization: string;
    meterDetails: {
        count: number;
        typeName: string;
        capacity: number;
    }[];
    utilizationClass: string;
};

// Define a type for rows with added span information for rendering
type RowWithSpanInfo = DisplayRow & {
    showTransformer: boolean;
    rowSpan: number;
};

type MergedBreakerData = {
    id: string;
    number: string;
    load: number;
    meters: IndividualMeter[];
    utilizationPercent: number;
    categories: Set<string>;
    meterTypes: Set<string>;
    timePatterns: Set<string>;
    isMerged: true; // Added for reliable type guarding
};

// A union type for what can be displayed in the panel view
type BreakerSlot =
    | { type: 'active'; data: Breaker }
    | { type: 'merged'; data: MergedBreakerData };


/**
 * Custom hook to process transformer data into display-ready rows for the main table.
 * It merges meters split across two breakers and calculates their utilization against a target.
 */
const useDisplayData = (transformers: Transformer[]): DisplayRow[] => {
    return useMemo(() => {
        // A type for the intermediate processing before final formatting
        type ProcessedRowData = {
            id: string | number;
            isMerged: boolean;
            transformer: Transformer;
            tIndex: number;
            number: string | number;
            categories: Set<string>;
            meters: IndividualMeter[];
            load: number;
            utilizationPercent: number;
        };

        const processedRows: ProcessedRowData[] = [];
        const handledBreakers = new Set<string>(); // Key: "t{t.id}-b{b.id}"

        const allBreakersWithTransformer = transformers.flatMap((transformer, tIndex) =>
            transformer.breakers.map(breaker => ({ ...breaker, transformer, tIndex }))
        );

        type BreakerWithTransformer = typeof allBreakersWithTransformer[0];
        const part1Meters = new Map<string, { breaker: BreakerWithTransformer, meter: IndividualMeter }>();

        // First pass: find all "Part 1" meters for quick lookup
        allBreakersWithTransformer.forEach(breaker => {
            breaker.meters.forEach(meter => {
                if (meter.note === 'جزء 1') {
                    const baseId = (meter.id as string).replace('_p1', '');
                    part1Meters.set(baseId, { breaker, meter });
                }
            });
        });

        // Second pass: Find pairs, create merged rows, and mark breakers as handled
        allBreakersWithTransformer.forEach(breaker2 => {
            const breaker2Key = `t${breaker2.transformer.id}-b${breaker2.id}`;
            if (handledBreakers.has(breaker2Key)) {
                return; // Already processed as part of a pair
            }

            // Look for a "part 2" meter to initiate a merge
            const part2Meter = breaker2.meters.find(m => m.note === 'جزء 2');
            if (part2Meter) {
                const baseId = (part2Meter.id as string).replace('_p2', '');
                if (part1Meters.has(baseId)) {
                    const { breaker: breaker1, meter: meter1 } = part1Meters.get(baseId)!;
                    
                    // Found a pair. Create one combined entry for breaker1 and breaker2.
                    const breaker1Key = `t${breaker1.transformer.id}-b${breaker1.id}`;
                    handledBreakers.add(breaker1Key);
                    handledBreakers.add(breaker2Key);

                    // Re-create the original meter that was split
                    const originalMeter = { ...meter1, id: baseId, cdl: meter1.cdl + part2Meter.cdl, note: undefined };
                    
                    // Combine all other meters from both breakers
                    const allMetersInPair = [
                        originalMeter,
                        ...breaker1.meters.filter(m => m.id !== meter1.id),
                        ...breaker2.meters.filter(m => m.id !== part2Meter.id)
                    ];

                    const combinedLoad = breaker1.load + breaker2.load;
                    // For merged view, utilization is against the capacity of two breakers
                    const utilizationPercent = (combinedLoad / 620) * 100; // Keep 620 for consistency with original logic

                    processedRows.push({
                        isMerged: true,
                        id: baseId,
                        transformer: breaker1.transformer,
                        tIndex: breaker1.tIndex,
                        number: `${breaker1.number} & ${breaker2.number}`,
                        categories: new Set([...breaker1.categories, ...breaker2.categories]),
                        meters: allMetersInPair,
                        load: combinedLoad,
                        utilizationPercent: utilizationPercent,
                    });
                }
            }
        });

        // Third pass: Add all un-merged breakers that have meters
        allBreakersWithTransformer.forEach(breaker => {
            const breakerKey = `t${breaker.transformer.id}-b${breaker.id}`;
            if (handledBreakers.has(breakerKey)) {
                return; // Skip breakers that were part of a merge
            }

            if (breaker.meters.length > 0) {
                processedRows.push({
                    ...breaker, // Contains all necessary fields
                    isMerged: false,
                });
            }
        });

        // Final transformation for rendering
        return processedRows.map(row => {
            const util = row.utilizationPercent;
            const meterGroups = Object.values(
                row.meters.reduce((acc: Record<string, { count: number; typeName: string; capacity: number; }>, meter: IndividualMeter) => {
                    const key = `${meter.typeName}_${meter.capacity}`;
                    if (!acc[key]) {
                        acc[key] = { count: 0, typeName: meter.typeName, capacity: meter.capacity };
                    }
                    acc[key].count++;
                    return acc;
                }, {})
            ).sort((a, b) => b.capacity - a.capacity);


            return {
                id: row.isMerged ? row.id as string : `t${row.tIndex}-b${row.id}`,
                isMerged: row.isMerged,
                transformerInfo: `المحول ${row.tIndex + 1} (${row.transformer.type.name})`,
                breakerNumber: String(row.number),
                categories: Array.from(row.categories).join(', '),
                meterCount: row.meters.length,
                load: row.load.toFixed(1),
                utilization: util.toFixed(1),
                meterDetails: meterGroups,
                utilizationClass: util > 95 ? 'bg-red-50' : util > 80 ? 'bg-amber-50' : '',
            };
        }).sort((a,b) => { // Sort for consistent order
            const tA = parseInt(a.transformerInfo.split(' ')[1]);
            const tB = parseInt(b.transformerInfo.split(' ')[1]);
            if (tA !== tB) return tA - tB;
            const numA = parseInt(String(a.breakerNumber).split('&')[0]);
            const numB = parseInt(String(b.breakerNumber).split('&')[0]);
            return numA - numB;
        });
    }, [transformers]);
};


const ResultsSection: React.FC<ResultsSectionProps> = ({ results }) => {
    
    const { summary, transformers } = results;
    const displayData = useDisplayData(transformers);

    const rowsWithSpanInfo = useMemo((): RowWithSpanInfo[] => {
        const rows: RowWithSpanInfo[] = [];
        if (!displayData || displayData.length === 0) return [];

        const spanMap = new Map<string, number>();
        for (const row of displayData) {
            spanMap.set(row.transformerInfo, (spanMap.get(row.transformerInfo) || 0) + 1);
        }

        let lastTransformerInfo: string | null = null;
        for (const row of displayData) {
            if (row.transformerInfo !== lastTransformerInfo) {
                rows.push({
                    ...row,
                    showTransformer: true,
                    rowSpan: spanMap.get(row.transformerInfo) || 1,
                });
                lastTransformerInfo = row.transformerInfo;
            } else {
                rows.push({
                    ...row,
                    showTransformer: false,
                    rowSpan: 1, // Will not be used
                });
            }
        }
        return rows;
    }, [displayData]);

    const exportToCSV = () => {
        let csvContent = "المحول,القاطع,نوع الأحمال,عدد العدادات,الحمل (A),نسبة الاستخدام (%),تفاصيل العدادات\n";

        displayData.forEach(row => {
            const detailsString = row.meterDetails.map(d => `${d.count}x${d.capacity}A ${d.typeName}`).join(' | ');
            csvContent += `"${row.transformerInfo}","${row.breakerNumber}","${row.categories}",${row.meterCount},${row.load},${row.utilization},"${detailsString}"\n`;
        });
        
        const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', 'التوزيع_المتوازن.csv');
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const printResults = () => {
        const printWindow = window.open('', '_blank');
        if (!printWindow) return;

        const tableHtml = `
            <table style="width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 12px;">
                <thead style="text-align: center;">
                    <tr>
                        <th style="border: 1px solid #ddd; padding: 6px; background-color: #f2f2f2;">المحول</th>
                        <th style="border: 1px solid #ddd; padding: 6px; background-color: #f2f2f2;">القاطع</th>
                        <th style="border: 1px solid #ddd; padding: 6px; background-color: #f2f2f2;">الحمل (A)</th>
                        <th style="border: 1px solid #ddd; padding: 6px; background-color: #f2f2f2;">الاستخدام (%)</th>
                        <th style="border: 1px solid #ddd; padding: 6px; background-color: #f2f2f2;">التفاصيل</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsWithSpanInfo.map(row => {
                         const detailsHtml = row.meterDetails.map(d => `
                            <div style="background-color: #f1f5f9; border-radius: 6px; padding: 5px; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between; font-size: 11px;">
                                <span style="background-color: #bae6fd; color: #0c4a6e; font-weight: bold; border-radius: 4px; padding: 2px 6px; flex-shrink: 0;">${d.count}x${d.capacity}A</span>
                                <span style="color: #475569; padding-right: 8px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${d.typeName}</span>
                            </div>
                        `).join('');
                         return `
                            <tr style="text-align: center;">
                                ${row.showTransformer ? `<td style="border: 1px solid #ddd; padding: 6px; vertical-align: middle;" rowspan="${row.rowSpan}">${row.transformerInfo}</td>` : ''}
                                <td style="border: 1px solid #ddd; padding: 6px;">${row.breakerNumber}</td>
                                <td style="border: 1px solid #ddd; padding: 6px;">${row.load}</td>
                                <td style="border: 1px solid #ddd; padding: 6px;">${row.utilization}%</td>
                                <td style="border: 1px solid #ddd; padding: 6px; text-align: right;">${detailsHtml}</td>
                            </tr>
                        `
                    }).join('')}
                </tbody>
            </table>
        `;

        const printContent = `
            <!DOCTYPE html>
            <html lang="ar" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <title>تقرير التوزيع المتوازن</title>
                <style> body { font-family: 'Tajawal', sans-serif; margin: 20px; } </style>
            </head>
            <body>
                <h1>تقرير التوزيع المتوازن للعدادات</h1>
                <h2>ملخص النتائج</h2>
                <p>إجمالي الحمل: ${summary.totalLoad}A / ${summary.totalLoadKVA} KVA</p>
                <p>عدد المحولات: ${summary.totalTransformers}</p>
                <p>نقاط التوازن: ${summary.balanceScore}%</p>
                <h2>جدول التوزيع</h2>
                ${tableHtml}
            </body>
            </html>
        `;
        
        printWindow.document.write(printContent);
        printWindow.document.close();
        printWindow.print();
    };

    return (
        <section id="resultsSection" className="mt-8 p-4 sm:p-6 bg-emerald-50 border-2 border-emerald-200 rounded-xl shadow-sm animate-fade-in">
            <h2 className="text-xl sm:text-2xl font-bold text-emerald-800 mb-6 pb-2 border-b-2 border-emerald-500">
                📈 نتائج التوزيع المتوازن
            </h2>
            <SummaryGrid summary={summary} />
            <div className="my-8">
                {transformers.map((transformer) => (
                    <TransformerCard key={transformer.id} transformer={transformer} />
                ))}
            </div>
            <ResultsTable rowsWithSpanInfo={rowsWithSpanInfo} />

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
                <button onClick={exportToCSV} className="w-full sm:w-auto bg-green-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-green-700 transition-colors shadow-lg flex items-center justify-center gap-2">
                    <DownloadIcon/> تصدير إلى Excel
                </button>
                <button onClick={printResults} className="w-full sm:w-auto bg-sky-600 text-white font-bold py-2 px-6 rounded-lg hover:bg-sky-700 transition-colors shadow-lg flex items-center justify-center gap-2">
                    <PrintIcon/> طباعة
                </button>
            </div>
        </section>
    );
};

const SummaryGrid: React.FC<{summary: DistributionSummary}> = ({ summary }) => {
    const stats = [
        { label: 'عدد المحولات', value: summary.totalTransformers },
        { label: 'القواطع المستخدمة', value: summary.totalBreakers, isBreakerStat: true },
        { label: 'إجمالي العدادات', value: summary.totalMeters },
        { label: 'إجمالي الحمل (أمبير)', value: summary.totalLoad },
        { label: 'إجمالي الحمل (KVA)', value: summary.totalLoadKVA },
        { label: 'نقاط التوازن', value: `${summary.balanceScore}%`, highlight: true },
        { label: 'الكفاءة الإجمالية', value: `${summary.efficiency}%`, highlight: true },
        { label: 'قواطع محملة زائد', value: summary.overloadedBreakers, danger: summary.overloadedBreakers > 0 },
    ];

    return (
         <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4 mb-8">
            {stats.map(stat => (
                <div key={stat.label} className={`p-4 rounded-lg text-center shadow ${stat.danger ? 'bg-red-100 border border-red-300' : 'bg-white border border-slate-200'}`}>
                    <p className={`text-2xl sm:text-3xl font-bold ${stat.highlight ? 'text-emerald-600' : 'text-slate-800'} ${stat.danger ? 'text-red-600' : ''}`}>{stat.value}</p>
                    <p className="text-sm text-slate-600 mt-1">{stat.label}</p>
                    {stat.isBreakerStat && summary.distributionEntries && summary.totalBreakers !== summary.distributionEntries && (
                         <p className="text-xs text-slate-500 mt-1">
                            ({`في ${summary.distributionEntries} صفوف بالجدول`})
                        </p>
                    )}
                </div>
            ))}
             <div className="col-span-2 md:col-span-4 lg:col-span-3 p-4 rounded-lg text-center shadow bg-white border border-slate-200">
                <p className="text-lg font-bold text-slate-800">تفاصيل المحولات</p>
                 <div className="text-sm text-slate-600 mt-2" dangerouslySetInnerHTML={{ __html: summary.transformerDetails || 'N/A' }}></div>
            </div>
        </div>
    )
}

const useProcessedBreakers = (transformer: Transformer): BreakerSlot[] => {
    return useMemo(() => {
        const slots: BreakerSlot[] = [];
        const activeBreakers = transformer.breakers.filter(b => b.meters.length > 0);
        if (activeBreakers.length === 0) {
             return [];
        }

        const part1Meters = new Map<string, { breaker: Breaker, meter: IndividualMeter }>();
        activeBreakers.forEach(breaker => {
            breaker.meters.forEach(meter => {
                if (meter.note === 'جزء 1') {
                    const baseId = (meter.id as string).replace('_p1', '');
                    part1Meters.set(baseId, { breaker, meter });
                }
            });
        });

        const mergedBreakerNumbers = new Set<number>();
        const mergedBreakers: MergedBreakerData[] = [];

        activeBreakers.forEach(breaker => {
            breaker.meters.forEach(meter => {
                if (meter.note === 'جزء 2') {
                    const baseId = (meter.id as string).replace('_p2', '');
                    if (part1Meters.has(baseId)) {
                        const { breaker: breaker1, meter: meter1 } = part1Meters.get(baseId)!;
                        mergedBreakerNumbers.add(breaker1.number);
                        mergedBreakerNumbers.add(breaker.number);
                        
                        const totalLoad = meter1.cdl + meter.cdl;
                        const originalMeter = { ...meter1, id: baseId, cdl: totalLoad, note: undefined };

                        mergedBreakers.push({
                            id: baseId,
                            number: `${breaker1.number} & ${breaker.number}`,
                            load: totalLoad,
                            meters: [originalMeter],
                            utilizationPercent: (totalLoad / 620) * 100,
                            categories: new Set([...breaker1.categories, ...breaker.categories]),
                            meterTypes: new Set([...breaker1.meterTypes, ...breaker.meterTypes]),
                            timePatterns: new Set([...breaker1.timePatterns, ...breaker.timePatterns]),
                            isMerged: true,
                        });
                    }
                }
            });
        });

        const activeBreakerMap = new Map<number, Breaker | MergedBreakerData>();
        mergedBreakers.forEach(mb => {
            const firstNum = parseInt(mb.number.split('&')[0].trim());
            activeBreakerMap.set(firstNum, mb);
        });
        activeBreakers.forEach(b => {
            if (!mergedBreakerNumbers.has(b.number)) {
                activeBreakerMap.set(b.number, b);
            }
        });

        for (let i = 1; i <= transformer.type.breakers; i++) {
            if (activeBreakerMap.has(i)) {
                const data = activeBreakerMap.get(i)!;
                // FIX: The previous type guard was not reliably narrowing the type.
                // Using a unique discriminant property 'isMerged' on MergedBreakerData resolves this ambiguity
                // and allows TypeScript to correctly infer the type in each branch.
                if (!('isMerged' in data)) {
                    // data is now correctly inferred as Breaker
                    slots.push({ type: 'active', data: data });
                } else {
                    // data is now correctly inferred as MergedBreakerData
                    slots.push({ type: 'merged', data: data });
                }
            }
        }
        return slots;
    }, [transformer]);
};


const TransformerCard: React.FC<{transformer: Transformer}> = ({ transformer }) => {
    const utilization = (transformer.assignedLoad / transformer.type.maxCurrent) * 100;
    const isOver80 = transformer.assignedLoad > transformer.type.safeLoad;
    
    const statusColor = transformer.isDedicated 
        ? 'border-purple-500 bg-purple-50' 
        : isOver80 
        ? 'border-red-500 bg-red-50' 
        : 'border-sky-500 bg-sky-50';

    const breakerSlots = useProcessedBreakers(transformer);
    const midPoint = Math.ceil(transformer.type.breakers / 2);
    const leftColumn = breakerSlots.filter(s => parseInt(String(s.data.number).split('&')[0]) <= midPoint);
    const rightColumn = breakerSlots.filter(s => parseInt(String(s.data.number).split('&')[0]) > midPoint);


    return (
        <div className={`mb-6 p-4 rounded-lg border-l-8 shadow-md ${statusColor}`}>
            <div className="flex justify-between items-start mb-4">
                <div>
                    <h3 className="text-lg font-bold text-slate-800">
                        {transformer.isDedicated 
                            ? `🔌 محول خاص (${transformer.type.name})`
                            : `⚡ المحول ${transformer.id}: ${transformer.type.name}`}
                        {transformer.isDedicated && (
                            <span className="text-sm font-normal text-purple-700"> {transformer.dedicatedFor}</span>
                        )}
                    </h3>
                    <p className="text-sm text-slate-600">
                        الحمل: {transformer.assignedLoad.toFixed(1)}A / {transformer.type.maxCurrent}A |
                        الاستخدام: {utilization.toFixed(1)}%
                    </p>
                </div>
                 {isOver80 && !transformer.isDedicated && <span className="text-xs font-bold bg-red-500 text-white py-1 px-2 rounded-full">يتجاوز 80%</span>}
            </div>
            {breakerSlots.length === 0 ? (
                <div className="text-center text-slate-500 py-4">لا توجد قواطع مستخدمة في هذا المحول.</div>
            ) : transformer.isDedicated ? (
                <div className="mt-4">
                     {breakerSlots.map(slot => 
                        <BreakerCard key={slot.data.id} breaker={slot.data} />
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    <div className="space-y-2">
                        {leftColumn.map(slot => 
                            <BreakerCard key={slot.data.id} breaker={slot.data} />
                        )}
                    </div>
                     <div className="space-y-2">
                        {rightColumn.map(slot => 
                            <BreakerCard key={slot.data.id} breaker={slot.data} />
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

const BreakerCard: React.FC<{breaker: Breaker | MergedBreakerData}> = ({ breaker }) => {
    const util = breaker.utilizationPercent;
    const isDedicated = 'dedicated' in breaker && breaker.dedicated;

    let bgColor = 'bg-green-100';
    let textColor = 'text-green-800';
    let borderColor = 'border-green-500';

    if (isDedicated) {
        bgColor = 'bg-purple-100';
        textColor = 'text-purple-800';
        borderColor = 'border-purple-500';
    } else if (util > 95) {
        bgColor = 'bg-red-100';
        textColor = 'text-red-800';
        borderColor = 'border-red-500';
    } else if (util > 80) {
        bgColor = 'bg-amber-100';
        textColor = 'text-amber-800';
        borderColor = 'border-amber-500';
    }

    const meterGroups = useMemo(() => {
        if (!breaker.meters || breaker.meters.length === 0) return [];
        const groups: Record<string, { count: number; capacity: number; typeName: string }> = {};
        breaker.meters.forEach(meter => {
            const key = `${meter.capacity}-${meter.typeName}`;
            if (!groups[key]) {
                groups[key] = { count: 0, capacity: meter.capacity, typeName: meter.typeName };
            }
            groups[key].count++;
        });
        return Object.values(groups).sort((a, b) => b.capacity - a.capacity);
    }, [breaker.meters]);


    return (
        <div className={`p-3 rounded-lg border ${borderColor} ${bgColor} ${textColor} flex flex-col`}>
            {/* Main Info */}
            <div className="flex-shrink-0">
                <div className="flex justify-between items-center">
                    <h4 className="font-bold">⚡ القاطع {breaker.number}</h4>
                    <span className="text-xs font-bold bg-black/10 py-0.5 px-2 rounded-full">{breaker.meters.length} عدادات</span>
                </div>
                {'dedicatedFor' in breaker && breaker.dedicatedFor && <p className="text-xs font-semibold opacity-90 mb-1">{breaker.dedicatedFor}</p>}
                <p className="text-sm">الحمل: {breaker.load.toFixed(1)}A</p>
                <p className="text-sm">الاستخدام: {util.toFixed(1)}%</p>
                <div className="w-full bg-black/10 rounded-full h-2.5 my-2">
                    <div className={`${isDedicated ? 'bg-purple-600' : util > 95 ? 'bg-red-600' : util > 80 ? 'bg-amber-500' : 'bg-green-600'} h-2.5 rounded-full`} style={{width: `${Math.min(util, 100)}%`}}></div>
                </div>
            </div>

            {/* Meter Details */}
            {meterGroups.length > 0 && (
                <div className="mt-2 pt-2 border-t border-black/10 flex-grow min-h-0">
                    <p className="text-xs font-bold mb-1 opacity-80">تفاصيل العدادات:</p>
                    <div className="max-h-24 overflow-y-auto space-y-1 pr-1">
                        {meterGroups.map((group, index) => (
                            <div key={index} className="text-xs flex justify-between items-center bg-white/40 p-1 rounded">
                                <span className="font-bold bg-sky-200 text-sky-800 text-[10px] rounded-md px-1.5 py-0.5 shrink-0">{`${group.count}x${group.capacity}A`}</span>
                                <span className="opacity-90 text-left pl-2 truncate">{group.typeName}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

const ResultsTable: React.FC<{rowsWithSpanInfo: RowWithSpanInfo[]}> = ({ rowsWithSpanInfo }) => {
    return (
        <div className="overflow-x-auto">
            <table id="resultsTable" className="w-full text-sm text-center text-slate-600 bg-white rounded-lg shadow-md">
                <thead className="text-xs text-slate-700 uppercase bg-slate-100">
                    <tr>
                        <th className="px-4 py-3">المحول</th>
                        <th className="px-4 py-3">القاطع</th>
                        <th className="px-4 py-3">نوع الأحمال</th>
                        <th className="px-4 py-3">عدد العدادات</th>
                        <th className="px-4 py-3">الحمل (A)</th>
                        <th className="px-4 py-3">الاستخدام (%)</th>
                        <th className="px-4 py-3">التفاصيل</th>
                    </tr>
                </thead>
                <tbody>
                    {rowsWithSpanInfo.map(row => (
                        <tr key={row.id} className={`border-b ${row.utilizationClass}`}>
                            {row.showTransformer && (
                                <td className="px-4 py-2 font-medium align-middle text-center" rowSpan={row.rowSpan}>
                                    {row.transformerInfo}
                                </td>
                            )}
                            <td className="px-4 py-2">{row.breakerNumber}</td>
                            <td className="px-4 py-2">{row.categories}</td>
                            <td className="px-4 py-2">{row.meterCount}</td>
                            <td className="px-4 py-2">{row.load}</td>
                            <td className="px-4 py-2 font-bold">{row.utilization}%</td>
                            <td className="px-4 py-2 text-xs">
                                <div className="flex flex-col items-center justify-center gap-1">
                                    {row.meterDetails.map((detail, index) => (
                                        <div key={index} className="flex items-center justify-between gap-3 bg-slate-100 rounded-lg p-1.5 text-slate-700 w-full max-w-[260px]">
                                            <span className="font-bold bg-sky-200 text-sky-800 text-[11px] rounded-md px-2 py-1 shrink-0">{`${detail.count}x${detail.capacity}A`}</span>
                                            <span className="text-slate-600 truncate text-right text-[12px]">{detail.typeName}</span>
                                        </div>
                                    ))}
                                </div>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

const DownloadIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="http://www.w3.org/2000/svg" fill="currentColor"><path fillRule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 9.293a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clipRule="evenodd" /></svg>;
const PrintIcon = () => <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="http://www.w3.org/2000/svg" fill="currentColor"><path fillRule="evenodd" d="M5 4v3H4a2 2 0 00-2 2v3a2 2 0 002 2h1v3a2 2 0 002 2h6a2 2 0 002-2v-3h1a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z" clipRule="evenodd" /></svg>;

export default ResultsSection;