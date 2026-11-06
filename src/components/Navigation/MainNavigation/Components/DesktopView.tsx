import React from 'react';
import { Anchor } from '@mantine/core';
import { Navigation } from '../navigationInterfaces';
import Link from 'next/link';
import Image from 'next/image';
import NavLogo from './NavLogo';
import SearchBar from './SearchBar';

interface DesktopViewProps {
  navigation: Navigation;
}

const DesktopView: React.FC<DesktopViewProps> = ({ navigation }) => (
  <>
    <div
      className="hidden lg:flex items-center mt-[-4px]"
      data-testid="mmrf-mainNavigation-logo"
    >
      <NavLogo navigation={navigation} />
    </div>
    {/* Seven links fit beside the logo from 1263px (1280 less a classic scrollbar) with this
        spacing; below xl the labels drop to 16px so the logo is squeezed less. */}
    <div
      className="hidden lg:flex space-x-2 ml-4 items-center"
      data-testid="mmrf-mainNavigation-links"
    >
      {navigation.items.map((link, i) => (
        <Anchor
          component={Link}
          key={i}
          href={link.href}
          className="text-mmrf-gunmetal whitespace-nowrap text-base xl:text-lg"
        >
          <Image
            src={link.icon}
            alt=""
            width={24}
            height={24}
            className="inline ml-2 mr-2 mt-[-3px]"
          />
          {link.name}
        </Anchor>
      ))}
      <div className="pl-3 hidden" data-testid="mmrf-mainNavigation-search">
        <SearchBar
          iconSrc={navigation.Search.icon}
          placeholderText={navigation.Search.placeholderText}
        />
      </div>
    </div>
  </>
);

export default DesktopView;
