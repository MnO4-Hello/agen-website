/**
 * Homepage hero: the 3D wordmark, its tagline, and the ground plate the maple
 * leaves land on. The sections that follow live beside this one so they can
 * scroll past it without disturbing its centring.
 */

export interface HomePage {
  section: HTMLElement;
  /** Heading the leaf physics treats as a set of platforms. */
  title: HTMLElement;
  /** Plate that leaves settle on. */
  ground: HTMLElement;
}

export function createHomePage(): HomePage {
  const section = document.createElement('section');
  section.className = 'home';

  const hero = document.createElement('div');
  hero.className = 'hero';

  const titleStage = document.createElement('div');
  titleStage.className = 'hero__title-stage';

  const title = document.createElement('h1');
  title.className = 'hero__title';
  title.textContent = '阿根';

  // A blurred, offset copy sits behind the heading to give it real depth.
  const titleShadow = document.createElement('span');
  titleShadow.className = 'hero__title-shadow';
  titleShadow.setAttribute('aria-hidden', 'true');
  titleShadow.textContent = '阿根';

  titleStage.append(titleShadow, title);

  const tagline = document.createElement('p');
  tagline.className = 'hero__tagline';
  tagline.textContent = '记录作品与思考的地方';

  const ground = document.createElement('div');
  ground.className = 'hero__ground';

  const hairline = document.createElement('span');
  hairline.className = 'hero__hairline';
  hairline.setAttribute('aria-hidden', 'true');

  ground.append(hairline);

  hero.append(titleStage, tagline, ground);

  section.append(hero);
  return { section, title, ground };
}
