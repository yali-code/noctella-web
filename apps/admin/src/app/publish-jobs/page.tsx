"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { PublishJob } from "@noctella/shared";
import { marketplaceApi, safeError } from "@/lib/marketplaces";
export default function PublishJobsPage(){ const [jobs,setJobs]=useState<PublishJob[]>([]); const [query,setQuery]=useState(""); useEffect(()=>{marketplaceApi.listJobs().then(setJobs)},[]); const filtered=jobs.filter(j=>JSON.stringify(j).toLowerCase().includes(query.toLowerCase())); return <div><h1>Publish Jobs</h1><input placeholder="Search/filter channel/status" value={query} onChange={(e)=>setQuery(e.target.value)} /><table><tbody>{filtered.map(j=><tr key={j.id}><td><Link href={`/publish-jobs/${j.id}`}>{j.id}</Link></td><td>{j.channel}</td><td>{j.status}</td><td><Link href={`/products/${j.productId}`}>{j.productId}</Link></td><td>{j.attemptCount}</td><td>{safeError(j.lastError)}</td></tr>)}</tbody></table></div> }
