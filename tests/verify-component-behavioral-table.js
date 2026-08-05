const fs = require('fs');
const { COMPONENT_BALANCE_PATH } = require('./src/server/config');
const { validateComponentBalance } = require('./src/server/componentSchema');

const balance = JSON.parse(fs.readFileSync(COMPONENT_BALANCE_PATH, 'utf8'));
const result = validateComponentBalance(balance, { filePath: COMPONENT_BALANCE_PATH });
if (!result.ok) {
  console.error(result.errors.join('\n'));
  process.exit(1);
}

console.log(`Component schema verification passed (${balance.components.length} components)`);

// Table-driven behavioral test for all active catalogue components
const behavioralTests = [];

for (const component of balance.components) {
  // Test normalization: component must have required fields
  behavioralTests.push({
    id: component.id,
    test: 'normalization',
    check: () => {
      const required = ['id', 'name', 'category', 'cost', 'mass', 'powerGeneration', 'powerUse'];
      for (const field of required) {
        if (!(field in component)) {
          throw new Error(`Missing required field: ${field}`);
        }
      }
      // Either hull or hp should be present
      if (!('hull' in component) && !('hp' in component)) {
        throw new Error('Missing required field: hull or hp');
      }
      return true;
    }
  });

  // Test footprint: if footprint exists, must have width and height
  if (component.footprint) {
    behavioralTests.push({
      id: component.id,
      test: 'footprint',
      check: () => {
        if (!('width' in component.footprint) || !('height' in component.footprint)) {
          throw new Error('Footprint missing width or height');
        }
        if (typeof component.footprint.width !== 'number' || typeof component.footprint.height !== 'number') {
          throw new Error('Footprint width/height must be numbers');
        }
        return true;
      }
    });
  }

  // Test category: must be valid category
  const validCategories = new Set(['Power', 'Propulsion', 'Weapons', 'Defence', 'Support', 'Command', 'Structure', 'Engines', 'Heat Components']);
  behavioralTests.push({
    id: component.id,
    test: 'category',
    check: () => {
      if (!validCategories.has(component.category)) {
        throw new Error(`Invalid category: ${component.category}`);
      }
      return true;
    }
  });

  // Test Power-source/consumer classification
  behavioralTests.push({
    id: component.id,
    test: 'power-classification',
    check: () => {
      const isGenerator = (component.powerGeneration || 0) > 0;
      const isStorage = (component.energyCapacity || 0) > 0 || (component.energyStorage || 0) > 0 || (component.maxDischargeRate || 0) > 0;
      const isConsumer = (component.powerUse || 0) > 0;
      
      // A component should not be both generator and consumer (except storage which can be both)
      if (isGenerator && isConsumer && !isStorage) {
        throw new Error('Component is both generator and consumer without storage');
      }
      return true;
    }
  });

  // Test weapon family: if weapon exists, must have valid family
  if (component.weapon) {
    const validFamilies = new Set(['blaster', 'missile', 'railgun', 'beam', 'pointDefense']);
    behavioralTests.push({
      id: component.id,
      test: 'weapon-family',
      check: () => {
        if (!component.weapon.family) {
          throw new Error('Weapon missing family');
        }
        if (!validFamilies.has(component.weapon.family)) {
          throw new Error(`Invalid weapon family: ${component.weapon.family}`);
        }
        return true;
      }
    });

    // Test target-priority tokens: if targetPriority exists, must have valid tokens
    if (component.weapon.targetPriority) {
      const validPriorities = new Set(['ship', 'missile', 'torpedo', 'swarmMissile', 'projectile', 'drone', 'droneFighter', 'droneOther']);
      behavioralTests.push({
        id: component.id,
        test: 'target-priority-tokens',
        check: () => {
          if (!Array.isArray(component.weapon.targetPriority)) {
            throw new Error('targetPriority must be an array');
          }
          for (const priority of component.weapon.targetPriority) {
            if (!validPriorities.has(priority)) {
              throw new Error(`Invalid target priority: ${priority}`);
            }
          }
          return true;
        }
      });
    }
  }

  // Test Data eligibility: check if component is a data source or target
  behavioralTests.push({
    id: component.id,
    test: 'data-eligibility',
    check: () => {
      const isDataSource = ['core', 'reactor', 'nuclearReactor', 'auxGenerator'].includes(component.id);
      const isDataTarget = !!component.weapon;
      // Data sources should have powerGeneration > 0
      if (isDataSource && (component.powerGeneration || 0) <= 0) {
        throw new Error('Data source must have powerGeneration > 0');
      }
      return true;
    }
  });

  // Test Heat role: check powerCategory for heat-related components
  if (component.powerCategory) {
    const validPowerCategories = new Set(['command', 'propulsion', 'shields', 'pointDefence', 'weapons', 'coolingSupport']);
    behavioralTests.push({
      id: component.id,
      test: 'heat-role',
      check: () => {
        if (!validPowerCategories.has(component.powerCategory)) {
          throw new Error(`Invalid powerCategory: ${component.powerCategory}`);
        }
        return true;
      }
    });
  }

  // Test placement limits: check maxPerShip if present
  if (component.maxPerShip !== undefined) {
    behavioralTests.push({
      id: component.id,
      test: 'placement-limits',
      check: () => {
        if (typeof component.maxPerShip !== 'number' || component.maxPerShip < 0) {
          throw new Error('maxPerShip must be a non-negative number');
        }
        return true;
      }
    });
  }
}

// Run all behavioral tests
let passed = 0;
let failed = 0;
for (const test of behavioralTests) {
  try {
    test.check();
    passed++;
  } catch (error) {
    console.error(`FAILED: ${test.id} - ${test.test}: ${error.message}`);
    failed++;
  }
}

console.log(`\nBehavioral tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
