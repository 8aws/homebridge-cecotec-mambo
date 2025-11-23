const { PlatformAccessory, Characteristic, Service } = require('hap-nodejs');
const axios = require('axios');

class MamboPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];
    this.token = config.token || null;
    this.recipes = config.recipes || [];
    if (!this.token) {
      this.login().then(() => {
        if (this.token) {
          this.config.token = this.token;
          this.api.updatePlatformConfig(this.config);
          this.log('Token almacenado en config');
        }
      });
    }
    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  async login() {
    try {
      const { data } = await axios.post('https://api.cecotec.com/auth/login', {
        email: this.config.email,
        password: this.config.password
      });
      this.token = data.token;
      this.log('Login exitoso');
    } catch (err) {
      this.log('Error login:', err.message);
    }
  }

  discoverDevices() {
    if (!this.token) return;
    axios.get('https://api.cecotec.com/devices', {
      headers: { 'Authorization': `Bearer ${this.token}` }
    }).then(res => {
      res.data.devices.forEach(device => {
        const acc = new PlatformAccessory(device.name, 'CookingUnique', device.id);
        this.accessories.push(acc);
        this.api.registerPlatformAccessories('homebridge-cecotec-mambo', 'MamboPlatform', [acc]);
        this.setupAccessory(acc);
      });
    }).catch(err => this.log('Error discover:', err.message));
  }

  setupAccessory(acc) {
    acc.context.cookingActive = false;
    acc.context.lastNextStep = null;

    const thermoService = new Service.Thermostat(acc.displayName);
    acc.addService(thermoService);

    thermoService.getCharacteristic(Characteristic.TargetTemperature)
      .onSet(async value => {
        if (value === 60) {
          await this.keepWarm(acc.context.deviceId);
          this.log(`${acc.displayName}: Mantener caliente activado`);
        }
      });

    const recipeService = new Service.Fan('Recetas Mambo');
    acc.addService(recipeService);

    recipeService.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: this.recipes.length - 1, minStep: 1 })
      .onSet(async value => {
        const recipe = this.recipes[value];
        if (recipe) {
          let recipeId;
          if (recipe.steps) {
            recipeId = await this.createCustomRecipe(acc.context.deviceId, recipe);
          } else {
            recipeId = recipe.id;
          }
          if (recipeId) {
            await this.startRecipe(acc.context.deviceId, recipeId);
          }
          this.log(`${acc.displayName}: Iniciando ${recipe.name}`);
          recipeService.updateCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE);
        }
      });

    const editService = new Service.Switch('Editar Receta');
    acc.addService(editService);

    editService.getCharacteristic(Characteristic.On)
      .onSet(async value => {
        if (value) {
          const status = await this.getStatus(acc.context.deviceId);
          const currentRecipe = this.recipes.find(r => r.id === status.currentRecipeId);
          if (currentRecipe) {
            const updates = { name: 'Receta Editada', steps: [{...currentRecipe.steps?.[0], time: 15 }] };
            await this.editRecipe(acc.context.deviceId, currentRecipe.id, updates);
            this.log(`${acc.displayName}: Receta editada`);
          }
          editService.updateCharacteristic(Characteristic.On, false);
        }
      });

    recipeService.getCharacteristic(Characteristic.Active)
      .onSet(async value => {
        if (value === Characteristic.Active.INACTIVE) {
          await this.stopRecipe(acc.context.deviceId);
          this.log(`${acc.displayName}: Parando receta`);
        }
      });

    const endSensorService = new Service.ContactSensor('Cocción Terminada');
    acc.addService(endSensorService);

    const startSensorService = new Service.ContactSensor('Inicio de Cocción');
    acc.addService(startSensorService);

    const stepSensorService = new Service.ContactSensor('Paso Intermedio');
    acc.addService(stepSensorService);

    const tempSensorService = new Service.TemperatureSensor('Temperatura Actual');
    acc.addService(tempSensorService);

    const humiditySensorService = new Service.HumiditySensor('Humedad Actual');
    acc.addService(humiditySensorService);

    const pressureSensorService = new Service.TemperatureSensor('Presión Actual');
    acc.addService(pressureSensorService);

    const weightSensorService = new Service.TemperatureSensor('Peso Actual');
    acc.addService(weightSensorService);

    const refreshTokenService = new Service.Switch('Refresh Token');
    acc.addService(refreshTokenService);

    refreshTokenService.getCharacteristic(Characteristic.On)
      .onSet(async value => {
        if (value) {
          await this.login();
          if (this.token) {
            this.config.token = this.token;
            this.api.updatePlatformConfig(this.config);
            this.log('Token refrescado');
          }
          refreshTokenService.updateCharacteristic(Characteristic.On, false);
        }
      });

    setInterval(async () => {
      if (!this.token) return;
      const status = await this.getStatus(acc.context.deviceId);
      const wasActive = acc.context.cookingActive;
      acc.context.cookingActive = status.active || false;

      const currentNextStep = status.nextStep;
      const newStepDetected = currentNextStep && currentNextStep !== acc.context.lastNextStep;
      acc.context.lastNextStep = currentNextStep;

      if (newStepDetected) {
        this.notify(`${acc.displayName}: Añadir paso: ${currentNextStep}`);
        stepSensorService.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);
        setTimeout(() => {
          stepSensorService.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
        }, 5000);
      }
      if (status.finished && wasActive) {
        this.notify(`${acc.displayName}: Cocción terminada`);
        recipeService.updateCharacteristic(Characteristic.Active, Characteristic.Active.INACTIVE);
        endSensorService.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);
        setTimeout(() => {
          endSensorService.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
        }, 5000);
      }
      if (!wasActive && acc.context.cookingActive) {
        this.notify(`${acc.displayName}: Cocción iniciada`);
        startSensorService.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_DETECTED);
        setTimeout(() => {
          startSensorService.updateCharacteristic(Characteristic.ContactSensorState, Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
        }, 5000);
      }
      const currentTemp = status.temp || 0;
      thermoService.updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);
      tempSensorService.updateCharacteristic(Characteristic.CurrentTemperature, currentTemp);
      const currentHumidity = status.humidity || 0;
      humiditySensorService.updateCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
      const currentPressure = status.pressure || 1013;
      pressureSensorService.updateCharacteristic(Characteristic.CurrentTemperature, currentPressure);
      const currentWeight = status.weight || 0;
      weightSensorService.updateCharacteristic(Characteristic.CurrentTemperature, currentWeight);
      const activeRecipeIndex = this.recipes.findIndex(r => r.id === status.currentRecipeId);
      if (activeRecipeIndex >= 0) {
        recipeService.updateCharacteristic(Characteristic.RotationSpeed, activeRecipeIndex);
      }
    }, 30000);

    acc.context.deviceId = acc.UUID;
  }

  async getStatus(deviceId) {
    if (!this.token) return {};
    return axios.post('https://api.cecotec.com/mambo/status', { deviceId }, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    }).then(res => res.data).catch(() => ({}));
  }

  async createCustomRecipe(deviceId, recipe) {
    if (!this.token) return null;
    return axios.post('https://api.cecotec.com/mambo/createRecipe', { deviceId, name: recipe.name, steps: recipe.steps }, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    }).then(res => res.data.recipeId).catch(() => null);
  }

  async editRecipe(deviceId, recipeId, updates) {
    if (!this.token) return;
    return axios.post('https://api.cecotec.com/mambo/editRecipe', { deviceId, recipeId, ...updates }, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async startRecipe(deviceId, recipeId) {
    if (!this.token) return;
    return axios.post('https://api.cecotec.com/mambo/startRecipe', { deviceId, recipeId }, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async stopRecipe(deviceId) {
    if (!this.token) return;
    return axios.post('https://api.cecotec.com/mambo/stopRecipe', { deviceId }, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  async keepWarm(deviceId) {
    if (!this.token) return;
    return axios.post('https://api.cecotec.com/mambo/keepwarm', { deviceId }, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
  }

  notify(message) {
    this.log('Notif: ' + message);
  }

  configureAccessory(acc) {
    this.setupAccessory(acc);
  }
}

module.exports = (api) => {
  api.registerPlatform('homebridge-cecotec-mambo', 'MamboPlatform', MamboPlatform);
};