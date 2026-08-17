import React, { useState } from 'react';
import { useT } from '../lib/i18n';

export interface FaqItem {
  question: string;
  answer: React.ReactNode;
}

export interface FaqAccordionProps extends React.HTMLAttributes<HTMLDivElement> {
  items?: FaqItem[];
  title?: string;
}

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}

/** Six Q&A keys, translated per active locale — see locales/*.ts `landing.faq.*`. */
const FAQ_KEYS = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'] as const;

export function FaqAccordion({
  items,
  title,
  className,
  ...props
}: FaqAccordionProps) {
  const t = useT();
  const resolvedItems: FaqItem[] =
    items ?? FAQ_KEYS.map((key) => ({ question: t(`landing.faq.${key}`), answer: t(`landing.faq.a${key.slice(1)}`) }));
  const resolvedTitle = title ?? t('landing.faq.title');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const toggleItem = (index: number) => {
    setActiveIndex(activeIndex === index ? null : index);
  };

  return (
    <div className={cn('w-full max-w-4xl mx-auto py-8 relative font-sans', className)} {...props}>
      {resolvedTitle && (
        <div className="text-center mb-10 space-y-2">
          <h2 className="font-bold text-2xl md:text-4xl text-ink tracking-tight">
            {resolvedTitle}
          </h2>
          <p className="text-fluid-xs text-muted max-w-xl mx-auto">{t('landing.faq.subtitle')}</p>
        </div>
      )}

      <ul className="w-full mx-auto list-none p-0 flex flex-col space-y-2">
        {resolvedItems.map((item, index) => {
          const isActive = activeIndex === index;
          return (
            <li
              key={index}
              className={cn(
                'w-full relative transition-all duration-300 ease-in rounded-2xl overflow-hidden border border-line bg-surface shadow-xs',
                isActive ? 'border-brand/40 ring-1 ring-brand/20' : 'hover:border-line/80'
              )}
            >
              <button
                type="button"
                className={cn(
                  'flex flex-row items-center justify-start w-full min-h-[64px] py-4 relative m-0 px-4 pl-14 cursor-pointer',
                  'border-l-[6px] md:border-l-[8px] transition-colors duration-200 text-left outline-none text-base md:text-lg',
                  isActive
                    ? 'border-l-brand bg-brand/5 text-ink font-bold'
                    : 'border-l-line bg-transparent text-muted hover:border-l-brand/60 hover:text-ink hover:bg-sunken/40'
                )}
                onClick={() => toggleItem(index)}
                aria-expanded={isActive}
              >
                {/* Plus/Minus Icon */}
                <span
                  className={cn(
                    'absolute left-4 md:left-5 top-1/2 -translate-y-1/2 transition-all duration-200 leading-none',
                    isActive
                      ? 'text-[28px] md:text-[36px] font-semibold text-brand'
                      : 'text-[22px] md:text-[28px] font-normal text-muted'
                  )}
                >
                  {isActive ? '−' : '+'}
                </span>

                <span className="pr-8 text-fluid-sm font-bold text-ink leading-snug">{item.question}</span>

                {/* Chevron */}
                <span
                  className={cn(
                    'absolute right-6 block w-2.5 h-2.5 border-t-2 border-r-2 transition-transform duration-200 ease-in-out',
                    isActive
                      ? 'rotate-[-45deg] border-brand'
                      : 'rotate-[135deg] border-muted'
                  )}
                />
              </button>

              <div
                className={cn(
                  'grid transition-all duration-300 ease-in-out w-full',
                  'border-l-[6px] md:border-l-[8px]',
                  isActive
                    ? 'grid-rows-[1fr] border-l-brand bg-brand/5'
                    : 'grid-rows-[0fr] border-l-line bg-transparent'
                )}
              >
                <div className="overflow-hidden">
                  <div className="flex flex-row items-start justify-start w-full px-4 pl-14 pb-6 pt-1 text-fluid-xs sm:text-fluid-sm font-normal text-muted leading-relaxed">
                    <span>{item.answer}</span>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default FaqAccordion;
