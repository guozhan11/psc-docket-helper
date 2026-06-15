import { useState, useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '../lib/utils';

// Global cache to avoid double-verifying the same link in the active session
const verifiedLinksCache = new Map<string, { valid: boolean; checked: boolean; checking: boolean }>();

// Helper utility to normalize and correct any DC PSC & eDocket URLs (e.g. converting lowercase paths to case-sensitive equivalents used by IIS)
export const normalizeUrl = (url: string): string => {
  if (!url) return '';
  let normalized = url.trim();
  
  // 1. Force HTTPS on dcpsc.org / edocket.dcpsc.org domains
  if (normalized.includes('dcpsc.org') && normalized.startsWith('http:')) {
    normalized = normalized.replace(/^http:/i, 'https:');
  }

  // 2. Fix Case-Sensitivity for e-Docket Search and CaseDetail URLs
  // This is critical because Microsoft IIS servers and ASP.NET backends return a 404 for lowercase routes/parameters
  if (normalized.includes('edocket.dcpsc.org')) {
    // Correct general search routing
    normalized = normalized.replace(/\/search\//i, '/Search/');
    
    // Correct CaseDetail and CaseSearch paths case-insensitively
    normalized = normalized.replace(/casedetail/i, 'CaseDetail');
    normalized = normalized.replace(/casesearch/i, 'CaseSearch');
    
    // Correct casenumber= query parameter case-insensitively to caseNumber=
    normalized = normalized.replace(/casenumber=/i, 'caseNumber=');
  }

  return normalized;
};

interface VerifiedLinkProps {
  href: string;
  children: React.ReactNode;
  className?: string;
  fallbackHref?: string;
}

export default function VerifiedLink({ href, children, className, fallbackHref = 'https://edocket.dcpsc.org/public/search' }: VerifiedLinkProps) {
  const normalized = normalizeUrl(href || '');
  
  const [status, setStatus] = useState(() => {
    return verifiedLinksCache.get(normalized) || { valid: true, checked: false, checking: false };
  });

  useEffect(() => {
    if (!normalized) return;
    
    const cached = verifiedLinksCache.get(normalized);
    if (cached) {
      setStatus(cached);
      return;
    }

    let isMounted = true;
    const checkLink = async () => {
      setStatus({ valid: true, checked: false, checking: true });
      verifiedLinksCache.set(normalized, { valid: true, checked: false, checking: true });

      try {
        const response = await fetch(`/api/verify-link?url=${encodeURIComponent(normalized)}`);
        if (!response.ok) throw new Error("Verification failed");
        
        const data = await response.json();
        const result = {
          valid: !!data.valid,
          checked: true,
          checking: false
        };

        if (isMounted) {
          setStatus(result);
        }
        verifiedLinksCache.set(normalized, result);
      } catch (err) {
        const result = {
          valid: false,
          checked: true,
          checking: false
        };
        if (isMounted) {
          setStatus(result);
        }
        verifiedLinksCache.set(normalized, result);
      }
    };

    checkLink();

    return () => {
      isMounted = false;
    };
  }, [normalized]);

  // If the link is verified as broken, fallback to eDocket Case Search
  const finalHref = status.checked && !status.valid 
    ? fallbackHref
    : normalized;

  return (
    <a
      href={finalHref}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "text-psc-blue hover:text-psc-blue/80 dark:text-blue-450 dark:hover:text-blue-350 underline font-bold transition-all inline-flex items-center gap-1.5",
        className
      )}
    >
      {children}
      <ExternalLink className="w-3.5 h-3.5 inline-block opacity-85" />
    </a>
  );
}
