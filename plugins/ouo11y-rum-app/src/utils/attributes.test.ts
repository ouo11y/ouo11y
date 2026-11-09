import { attributeFilters, attributeParams, attributeSessionsSearch, parseAttributeInput } from './attributes';

describe('attribute filters', () => {
  it('reads attr.* params sorted by key and skips empty values', () => {
    const q = new URLSearchParams('from=now-1h&attr.tenant=acme&user=u&attr.plan=pro&attr.empty=');
    expect(attributeFilters(q)).toEqual({ plan: 'pro', tenant: 'acme' });
    expect(Object.keys(attributeFilters(q))).toEqual(['plan', 'tenant']);
    expect(attributeParams({ tenant: 'acme' })).toEqual({ 'attr.tenant': 'acme' });
  });

  it('parses key=value and rejects what rum-api would refuse', () => {
    expect(parseAttributeInput(' tenant = acme corp ')).toEqual({ key: 'tenant', value: 'acme corp' });
    expect(parseAttributeInput('q=a=b')).toEqual({ key: 'q', value: 'a=b' });
    expect(parseAttributeInput('tenant')).toHaveProperty('error');
    expect(parseAttributeInput('ten-ant=x')).toHaveProperty('error');
    expect(parseAttributeInput('a.b=x')).toHaveProperty('error');
    expect(parseAttributeInput('_x=x')).toHaveProperty('error');
    expect(parseAttributeInput('tenant=')).toHaveProperty('error');
    expect(parseAttributeInput(`tenant=${'v'.repeat(129)}`)).toHaveProperty('error');
    expect(parseAttributeInput('tenant=a\u0007b')).toHaveProperty('error');
  });

  it('builds a Sessions search filtered by one attribute', () => {
    expect(attributeSessionsSearch('tenant', 'a&b', { from: 'now-1h', to: 'now' })).toBe('from=now-1h&to=now&attr.tenant=a%26b');
  });
});
