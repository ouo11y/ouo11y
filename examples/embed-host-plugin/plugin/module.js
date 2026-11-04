/*
 * ouo embed host fixture (R5, ADR-0019).
 *
 * A host app plugin in one hand-written AMD module, no build step: Grafana loads plugin modules
 * with SystemJS, which reads AMD, and hands it the shared react / @grafana/* modules. It mounts
 * ouo's three exposed components with usePluginComponent, the way a customer's own plugin would,
 * to prove the contract end to end. Provisioned only by deploy/compose/compose.embed-host.yaml.
 *
 * URL query of the page: from, to (time range), project, app (scope), sessionId (the session shown
 * at the bottom; clicking a row of the sessions list sets it).
 */
define(['react', '@grafana/data', '@grafana/runtime', '@grafana/ui'], function (React, data, runtime, ui) {
  'use strict';

  var h = React.createElement;
  var IDS = {
    health: 'ouo11y-rum-app/overview-health/v1',
    list: 'ouo11y-rum-app/sessions-list/v1',
    detail: 'ouo11y-rum-app/session-detail/v1',
  };

  /** One exposed component, or why it is missing. */
  function Embedded(props) {
    var result = runtime.usePluginComponent(props.id);
    if (result.isLoading) {
      return h(ui.LoadingPlaceholder, { text: 'Loading ' + props.id });
    }
    if (!result.component) {
      return h(
        ui.Alert,
        { severity: 'error', title: props.id + ' is not available' },
        'Is ouo11y-rum-app installed, enabled and at least the version that exposes it?'
      );
    }
    return h('div', { 'data-testid': 'host-slot-' + props.slot }, h(result.component, props.componentProps));
  }

  function Section(props) {
    return h(
      'section',
      {
        style: {
          border: '1px dashed rgba(204, 204, 220, 0.4)',
          borderRadius: 4,
          padding: 16,
          marginBottom: 16,
        },
      },
      h('h3', { style: { marginTop: 0 } }, props.title, ' ', h('code', { style: { fontSize: 12 } }, props.id)),
      props.children
    );
  }

  function HostPage() {
    var query = runtime.locationService.getSearchObject();
    var initial = query.sessionId ? String(query.sessionId) : '';
    var state = React.useState(initial);
    var sessionId = state[0];
    var setSessionId = state[1];

    var timeRange = { from: String(query.from || 'now-24h'), to: String(query.to || 'now') };
    var scope = {
      project: query.project ? String(query.project) : undefined,
      app: query.app ? String(query.app) : undefined,
    };

    function pick(id) {
      setSessionId(id);
      runtime.locationService.partial({ sessionId: id }, true);
    }

    var linkOut =
      '/a/ouo11y-rum-app/sessions/' +
      encodeURIComponent(sessionId) +
      '?from=' +
      encodeURIComponent(timeRange.from) +
      '&to=' +
      encodeURIComponent(timeRange.to);

    return h(
      runtime.PluginPage,
      { subTitle: 'A host plugin mounting ouo views with usePluginComponent. Everything inside the dashed boxes is ouo.' },
      h(
        Section,
        { title: 'Session health', id: IDS.health },
        h(Embedded, { id: IDS.health, slot: 'health', componentProps: Object.assign({ timeRange: timeRange }, scope) })
      ),
      h(
        Section,
        { title: 'Sessions', id: IDS.list },
        h(Embedded, {
          id: IDS.list,
          slot: 'list',
          componentProps: Object.assign({ timeRange: timeRange, limit: 20, onSessionClick: pick }, scope),
        })
      ),
      h(
        Section,
        { title: 'Session detail', id: IDS.detail },
        sessionId
          ? h(
              React.Fragment,
              null,
              h(
                'p',
                null,
                'Session ',
                h('code', { 'data-testid': 'host-session-id' }, sessionId),
                ' · ',
                h('a', { href: linkOut, style: { textDecoration: 'underline' } }, 'Open in ouo (link out)')
              ),
              h(Embedded, {
                id: IDS.detail,
                slot: 'detail',
                componentProps: Object.assign({ sessionId: sessionId, timeRange: timeRange }, scope),
              })
            )
          : h('p', null, 'Click a session above, or open this page with ?sessionId=<id>.')
      )
    );
  }

  return { plugin: new data.AppPlugin().setRootPage(HostPage) };
});
