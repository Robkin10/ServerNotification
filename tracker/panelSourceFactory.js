/** Creates a consistent, authenticated panel source for legacy or saved servers. */
class PanelSourceFactory {
  constructor({
    multiServerMode,
    listClients,
    getClientDetails,
    getClientLinks,
    createPanelService,
    twoFactorCode
  }) {
    this.multiServerMode = multiServerMode;
    this.listClients = listClients;
    this.getClientDetails = getClientDetails;
    this.getClientLinks = getClientLinks;
    this.createPanelService = createPanelService;
    this.twoFactorCode = twoFactorCode;
  }

  async create(server) {
    if (!this.multiServerMode) {
      return {
        clients: await this.listClients({ twoFactorCode: this.twoFactorCode() }),
        getClientDetails: (email) => this.getClientDetails(email, { twoFactorCode: this.twoFactorCode() }),
        getClientLinks: (email) => this.getClientLinks(email, { twoFactorCode: this.twoFactorCode() })
      };
    }

    const panel = await this.createPanelService({
      baseUrl: server.base_url,
      bearerToken: server.bearer_token,
      username: server.username,
      password: server.password
    });
    return {
      clients: await panel.listClients({ twoFactorCode: this.twoFactorCode() }),
      getClientDetails: (email) => panel.getClientDetails(email, { twoFactorCode: this.twoFactorCode() }),
      getClientLinks: (email) => panel.getClientLinks(email, { twoFactorCode: this.twoFactorCode() })
    };
  }
}

module.exports = { PanelSourceFactory };
