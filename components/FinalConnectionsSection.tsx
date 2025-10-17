import React from 'react';
import { FinalConnection } from '../types';

interface FinalConnectionsSectionProps {
    connections: FinalConnection[];
}

const FinalConnectionsSection: React.FC<FinalConnectionsSectionProps> = ({ connections }) => {
    return (
        <div className="mt-12">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-800 mb-6 pb-2 border-b-2 border-slate-500">
                🔌 تفاصيل توصيلات شبكة الجهد المنخفض
            </h2>
            <div className="overflow-x-auto">
                <table className="w-full text-sm text-center text-slate-600 bg-white rounded-lg shadow-md">
                    <thead className="text-xs text-slate-700 uppercase bg-slate-100">
                        <tr>
                            <th className="px-4 py-3">نقطة التوصيل</th>
                            <th className="px-4 py-3">مصدر التغذية</th>
                            <th className="px-4 py-3">إجمالي الحمل (CDL)</th>
                            <th className="px-4 py-3">تكوين المغذي الرئيسي</th>
                            <th className="px-4 py-3">تكوين كابل العميل</th>
                            <th className="px-4 py-3">صناديق العدادات</th>
                            <th className="px-4 py-3">العدادات</th>
                        </tr>
                    </thead>
                    <tbody>
                        {connections.map(conn => (
                            <tr key={conn.id} className="border-b hover:bg-slate-50">
                                <td className="px-4 py-2 font-medium">
                                    {conn.transformerName}<br/>
                                    <span className="text-xs text-slate-500">
                                        القاطع {conn.breakerNumber}
                                        {conn.dpOutletNumber && ` / المخرج ${conn.dpOutletNumber}`}
                                    </span>
                                </td>
                                <td className="px-4 py-2">
                                    <span className={`font-bold px-2 py-1 rounded-full text-xs ${conn.configuration.source === 'DP' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'}`}>
                                        {conn.configuration.source}
                                    </span>
                                </td>
                                <td className="px-4 py-2 font-bold">{conn.totalCDL.toFixed(1)}A</td>
                                <td className="px-4 py-2">{conn.configuration.mainFeederInfo}</td>
                                <td className="px-4 py-2">{`${conn.configuration.customerCableCount}x ${conn.configuration.customerCableSize}`}</td>
                                <td className="px-4 py-2">{conn.meterBoxes}</td>
                                <td className="px-4 py-2 text-xs">
                                     <div className="flex flex-col items-center justify-center gap-1">
                                        {Object.values(conn.meters.reduce((acc: Record<string, {count: number, typeName: string, capacity: number}>, meter) => {
                                            const key = `${meter.typeName}_${meter.capacity}`;
                                            if (!acc[key]) acc[key] = { count: 0, typeName: meter.typeName, capacity: meter.capacity };
                                            acc[key].count++;
                                            return acc;
                                        }, {})).map((detail, index) => (
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
        </div>
    );
};

export default FinalConnectionsSection;